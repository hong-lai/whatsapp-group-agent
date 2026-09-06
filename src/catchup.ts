import {
    isJidGroup,
    jidNormalizedUser,
    proto,
    type WAMessage,
    type WAMessageKey,
    type WASocket,
} from '@whiskeysockets/baileys'
import { getGroupMetadata } from './cache.js'
import { config, matchesGroupPattern } from './config.js'
import {
    ensureGroupHistoryFloor,
    getGroupHistoryFloor,
    getLatestGroupMessage,
    getOldestGroupMessage,
    type LatestGroupMessage,
} from './db.js'
import { log } from './log.js'
import { settleDelayMs, sleep, waitHistoryRequest } from './rateLimit.js'

/** Walk older pages until the sticky first-login floor. */
type CatchupMode = 'initial' | 'gap'

type CatchupJob = {
    groupJid: string
    key: WAMessageKey
    timestamp: number
    mode: CatchupMode
}

const FETCH_RETRY_MAX = 3
const AWAITING_TIMEOUT_MS = 90_000

function unixSeconds(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000)
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

function historySyncNumber(syncType: unknown): number | undefined {
    if (typeof syncType === 'number' && Number.isFinite(syncType)) return syncType
    if (typeof syncType === 'string') {
        const named = proto.HistorySync.HistorySyncType[syncType as keyof typeof proto.HistorySync.HistorySyncType]
        if (typeof named === 'number') return named
        const parsed = Number(syncType)
        if (Number.isFinite(parsed)) return parsed
    }
    return undefined
}

function isMessageHistorySync(syncType: unknown): boolean {
    const n = historySyncNumber(syncType)
    return (
        n === undefined ||
        n === proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP ||
        n === proto.HistorySync.HistorySyncType.FULL ||
        n === proto.HistorySync.HistorySyncType.RECENT ||
        n === proto.HistorySync.HistorySyncType.ON_DEMAND
    )
}

/** WhatsApp push syncs we wait for before starting on-demand catchup. */
function isBulkHistorySync(syncType: unknown): boolean {
    const n = historySyncNumber(syncType)
    return (
        n === proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP ||
        n === proto.HistorySync.HistorySyncType.FULL ||
        n === proto.HistorySync.HistorySyncType.RECENT
    )
}

export function asCatchupMessage(value: { key?: WAMessageKey | null } | null | undefined): WAMessage | undefined {
    return value?.key ? (value as WAMessage) : undefined
}

export function createCatchup(sock: WASocket) {
    const defaultFloor = Math.floor(Date.now() / 1000) - config.catchupBackfillSeconds
    const pages = new Map<string, number>()
    const jobs = new Map<string, CatchupJob>()
    const awaitingOnDemand = new Set<string>()
    const pendingPdoOrder: string[] = []
    const pendingMode = new Map<string, CatchupMode>()
    const awaitingSince = new Map<string, number>()
    const fetchAttempts = new Map<string, number>()
    const incompleteAttempts = new Map<string, number>()
    /**
     * For gap-fill: DB latest timestamp when the gap request started.
     * Paging stops once an on-demand page reaches this watermark.
     */
    const gapTargetTs = new Map<string, number>()
    const floorCache = new Map<string, number>()
    const finished = new Set<string>()
    /** Latest known message per chat (full payload when available — needed to ingest the head itself). */
    const chatHeads = new Map<string, WAMessage>()
    let trackedJids: string[] = []
    /** Wait for RECENT/FULL before mass catchup (or settle timeout). */
    let seenBulkHistory = false
    const startedAt = Date.now()
    let allowingRequests = false
    let draining = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    async function isTrackedGroup(groupJid: string): Promise<boolean> {
        const cached = await getGroupMetadata(groupJid)
        return cached ? matchesGroupPattern(cached.subject) : false
    }

    async function floorFor(groupJid: string): Promise<number> {
        const cached = floorCache.get(groupJid)
        if (cached !== undefined) return cached
        const floor = await ensureGroupHistoryFloor(groupJid, defaultFloor)
        floorCache.set(groupJid, floor)
        return floor
    }

    function clearAwaiting(groupJid: string): void {
        awaitingOnDemand.delete(groupJid)
        pendingMode.delete(groupJid)
        awaitingSince.delete(groupJid)
        const index = pendingPdoOrder.indexOf(groupJid)
        if (index >= 0) pendingPdoOrder.splice(index, 1)
    }

    function finish(groupJid: string, why: string): void {
        clearAwaiting(groupJid)
        gapTargetTs.delete(groupJid)
        fetchAttempts.delete(groupJid)
        incompleteAttempts.delete(groupJid)
        finished.add(groupJid)
        log.info({ groupJid, why }, 'catchup.complete')
    }

    function rememberPendingPdo(groupJid: string, mode: CatchupMode): void {
        if (!awaitingOnDemand.has(groupJid)) pendingPdoOrder.push(groupJid)
        awaitingOnDemand.add(groupJid)
        pendingMode.set(groupJid, mode)
        awaitingSince.set(groupJid, Date.now())
    }

    function historyKeyFromStored(groupJid: string, stored: LatestGroupMessage): WAMessageKey {
        const me = sock.user?.id ? jidNormalizedUser(sock.user.id) : undefined
        const sender = stored.senderJid ? jidNormalizedUser(stored.senderJid) : undefined
        return {
            remoteJid: groupJid,
            id: stored.messageId,
            fromMe: Boolean(me && sender && me === sender),
            ...(stored.senderJid ? { participant: stored.senderJid } : {}),
        }
    }

    function clearSettleTimer(): void {
        if (settleTimer) {
            clearTimeout(settleTimer)
            settleTimer = undefined
        }
    }

    function scheduleSettle(reason: string): void {
        if (stopped) return
        allowingRequests = false
        clearSettleTimer()
        const waitMs = settleDelayMs()
        log.debug({ waitMs, reason, pending: jobs.size }, 'catchup.settling')
        settleTimer = setTimeout(() => {
            void (async () => {
                if (stopped) return
                allowingRequests = true
                await enqueueTrackedCatchup()
                log.info({ pending: jobs.size, reason }, 'catchup.ready')
                void drain()
            })()
        }, waitMs)
    }

    function releaseStaleAwaiting(): void {
        const now = Date.now()
        for (const groupJid of [...awaitingOnDemand]) {
            const since = awaitingSince.get(groupJid) ?? now
            if (now - since < AWAITING_TIMEOUT_MS) continue
            log.warn({ groupJid, waitedMs: now - since }, 'catchup.awaiting_timeout')
            clearAwaiting(groupJid)
            finished.delete(groupJid)
        }
    }

    function headAnchor(
        groupJid: string
    ): { key: WAMessageKey; timestamp: number; message: WAMessage } | undefined {
        const message = chatHeads.get(groupJid)
        if (!message?.key.id) return undefined
        return {
            key: message.key,
            timestamp: unixSeconds(message.messageTimestamp),
            message,
        }
    }

    async function enqueueTrackedCatchup(): Promise<void> {
        if (!seenBulkHistory && Date.now() - startedAt > 180_000) {
            seenBulkHistory = true
            log.info('catchup.bulk_history_timeout')
        }
        if (!seenBulkHistory) {
            scheduleSettle('waiting-bulk-history')
            return
        }

        releaseStaleAwaiting()

        for (const groupJid of trackedJids) {
            await enqueueCatchupForGroup(groupJid)
        }
    }

    async function enqueueCatchupForGroup(groupJid: string): Promise<void> {
        if (finished.has(groupJid) || jobs.has(groupJid) || awaitingOnDemand.has(groupJid)) {
            return
        }
        const page = pages.get(groupJid) ?? 0
        if (page >= config.catchupMaxPages) {
            finish(groupJid, 'page-limit')
            return
        }

        const floor = await floorFor(groupJid)
        const latest = await getLatestGroupMessage(groupJid)
        const oldest = await getOldestGroupMessage(groupJid)
        const head = headAnchor(groupJid)

        // Reconnect / mid-session gap: walk back from head until DB latest.
        if (
            head &&
            latest &&
            head.timestamp > latest.timestamp + 2 &&
            head.key.id !== latest.messageId
        ) {
            gapTargetTs.set(groupJid, latest.timestamp)
            enqueue({
                groupJid,
                key: head.key,
                timestamp: head.timestamp,
                mode: 'gap',
            })
            return
        }

        // First login (or incomplete first login): deepen until sticky floor.
        if (oldest?.messageId && oldest.timestamp > floor) {
            enqueue({
                groupJid,
                key: historyKeyFromStored(groupJid, oldest),
                timestamp: oldest.timestamp,
                mode: 'initial',
            })
            return
        }

        // Head exists but no DB rows yet — pull older from head toward floor.
        if (head && !latest) {
            if (head.timestamp <= floor) {
                finish(groupJid, 'head-before-floor')
                return
            }
            enqueue({
                groupJid,
                key: head.key,
                timestamp: head.timestamp,
                mode: 'initial',
            })
            return
        }

        if (oldest && oldest.timestamp <= floor) {
            finish(
                groupJid,
                latest && latest.timestamp < floor ? 'inactive' : 'initial-floor-reached'
            )
        }
    }

    async function requestFromAnchor(job: CatchupJob): Promise<'done' | 'retry'> {
        const { groupJid, key, timestamp, mode } = job
        const page = pages.get(groupJid) ?? 0
        if (!key.id) return 'done'
        if (page >= config.catchupMaxPages) return 'done'
        const floor = await floorFor(groupJid)
        if (mode === 'initial' && timestamp <= floor) return 'done'

        try {
            if (mode === 'gap') {
                const latest = await getLatestGroupMessage(groupJid)
                if (latest && latest.timestamp >= timestamp - 2) return 'done'
                if (!gapTargetTs.has(groupJid) && latest) {
                    gapTargetTs.set(groupJid, latest.timestamp)
                }
            }

            const waitedMs = await waitHistoryRequest()
            if (stopped) return 'done'
            if (!allowingRequests) return 'retry'

            await sock.fetchMessageHistory(config.catchupPageSize, key, timestamp * 1000)
            fetchAttempts.delete(groupJid)
            rememberPendingPdo(groupJid, mode)
            log.info(
                {
                    groupJid,
                    messageId: key.id,
                    page: page + 1,
                    mode,
                    waitedMs,
                    floor,
                    gapTarget: gapTargetTs.get(groupJid),
                    fromMe: key.fromMe,
                },
                'catchup.history_requested'
            )
            return 'done'
        } catch (err) {
            const attempts = (fetchAttempts.get(groupJid) ?? 0) + 1
            fetchAttempts.set(groupJid, attempts)
            log.warn(
                { err, groupJid, messageId: key.id, mode, attempts },
                'catchup.history_request_failed'
            )
            if (attempts < FETCH_RETRY_MAX) {
                await sleep(Math.min(30_000, 2000 * attempts))
                if (stopped) return 'done'
                return 'retry'
            }
            finish(groupJid, 'fetch-failed')
            return 'done'
        }
    }

    async function drain(): Promise<void> {
        if (draining || stopped || !allowingRequests) return
        draining = true
        try {
            while (!stopped && allowingRequests) {
                const next = jobs.values().next().value as CatchupJob | undefined
                if (!next) break
                const result = await requestFromAnchor(next)
                if (result === 'retry') {
                    // Keep job queued; pause drain until settle / next allow.
                    if (!allowingRequests) break
                    continue
                }
                if (jobs.get(next.groupJid) === next) jobs.delete(next.groupJid)
            }
        } finally {
            draining = false
            if (!stopped && allowingRequests && jobs.size > 0) void drain()
        }
    }

    function enqueue(job: CatchupJob): void {
        if (stopped || !job.key.id) return
        const page = pages.get(job.groupJid) ?? 0
        if (page >= config.catchupMaxPages) return
        const existing = jobs.get(job.groupJid)
        if (existing?.mode === 'gap' && job.mode === 'initial') return
        jobs.set(job.groupJid, job)
        if (allowingRequests) void drain()
    }

    async function continueOrFinishIncomplete(
        groupJid: string,
        oldestMsg: WAMessage,
        oldestTs: number,
        mode: CatchupMode,
        why: string
    ): Promise<void> {
        const floor = await floorFor(groupJid)
        const stillNeedGap =
            mode === 'gap' &&
            gapTargetTs.has(groupJid) &&
            oldestTs > (gapTargetTs.get(groupJid) ?? 0) + 2
        const stillNeedInitial = mode === 'initial' && oldestTs > floor
        if (!stillNeedGap && !stillNeedInitial) {
            finish(groupJid, why)
            return
        }

        const attempts = (incompleteAttempts.get(groupJid) ?? 0) + 1
        incompleteAttempts.set(groupJid, attempts)
        if (attempts >= FETCH_RETRY_MAX) {
            finish(groupJid, `${why}-gave-up`)
            return
        }

        log.warn(
            { groupJid, oldestTs, floor, target: gapTargetTs.get(groupJid), why, attempts },
            'catchup.incomplete_retry'
        )
        finished.delete(groupJid)
        const head = headAnchor(groupJid)
        const key = stillNeedGap && head ? head.key : oldestMsg.key!
        const ts = stillNeedGap && head ? head.timestamp : oldestTs
        enqueue({
            groupJid,
            key,
            timestamp: ts,
            mode: stillNeedGap ? 'gap' : 'initial',
        })
        scheduleSettle('incomplete-retry')
    }

    /** Live / notify / chat-head: fill from this message back to DB latest (or floor if empty). */
    async function considerMessage(m: WAMessage, _reason: string): Promise<void> {
        const groupJid = m.key.remoteJid
        if (stopped || !groupJid || !isJidGroup(groupJid) || !m.key.id) return
        if (!(await isTrackedGroup(groupJid))) return

        const timestamp = unixSeconds(m.messageTimestamp)
        const previous = await getLatestGroupMessage(groupJid)
        if (previous && previous.messageId === m.key.id) return
        if (previous && previous.timestamp >= timestamp - 2) return

        finished.delete(groupJid)
        pages.delete(groupJid)

        if (!previous) {
            // Cold group: treat as initial deepen toward sticky floor.
            await floorFor(groupJid)
            enqueue({
                groupJid,
                key: m.key,
                timestamp,
                mode: 'initial',
            })
            return
        }

        gapTargetTs.set(groupJid, previous.timestamp)
        enqueue({
            groupJid,
            key: m.key,
            timestamp,
            mode: 'gap',
        })
    }

    async function considerHistoryBatch(messages: WAMessage[], syncType: unknown): Promise<void> {
        if (stopped || !isMessageHistorySync(syncType)) return
        const onDemand =
            historySyncNumber(syncType) === proto.HistorySync.HistorySyncType.ON_DEMAND
        if (onDemand && messages.length === 0) {
            const groupJid = pendingPdoOrder[0]
            if (groupJid && awaitingOnDemand.has(groupJid)) {
                const mode = pendingMode.get(groupJid) ?? 'initial'
                clearAwaiting(groupJid)
                const head = headAnchor(groupJid)
                const oldest = await getOldestGroupMessage(groupJid)
                if (head) {
                    await continueOrFinishIncomplete(
                        groupJid,
                        head.message,
                        head.timestamp,
                        mode,
                        'empty-on-demand'
                    )
                } else if (oldest?.messageId) {
                    await continueOrFinishIncomplete(
                        groupJid,
                        {
                            key: historyKeyFromStored(groupJid, oldest),
                            messageTimestamp: oldest.timestamp,
                        } as WAMessage,
                        oldest.timestamp,
                        mode,
                        'empty-on-demand'
                    )
                } else {
                    finish(groupJid, 'empty-on-demand')
                }
            }
            return
        }
        if (messages.length === 0) return

        const byGroup = new Map<string, WAMessage[]>()
        for (const message of messages) {
            const groupJid = message.key.remoteJid
            if (!groupJid || !isJidGroup(groupJid)) continue
            const list = byGroup.get(groupJid) ?? []
            list.push(message)
            byGroup.set(groupJid, list)
        }

        for (const [groupJid, list] of byGroup) {
            const mode = pendingMode.get(groupJid) ?? 'initial'
            if (onDemand) {
                clearAwaiting(groupJid)
                pages.set(groupJid, (pages.get(groupJid) ?? 0) + 1)
            }
            if (!(await isTrackedGroup(groupJid))) continue

            list.sort(
                (left, right) => unixSeconds(left.messageTimestamp) - unixSeconds(right.messageTimestamp)
            )
            const oldestMsg = list[0]
            if (!oldestMsg?.key.id) continue
            const oldestTs = unixSeconds(oldestMsg.messageTimestamp)
            const shortPage = list.length < config.catchupPageSize
            const floor = await floorFor(groupJid)

            if (onDemand) {
                if (mode === 'gap') {
                    const target = gapTargetTs.get(groupJid)
                    if (target !== undefined && oldestTs <= target + 2) {
                        finish(groupJid, 'gap-closed')
                        continue
                    }
                    if (shortPage) {
                        await continueOrFinishIncomplete(
                            groupJid,
                            oldestMsg,
                            oldestTs,
                            'gap',
                            'short-page'
                        )
                        continue
                    }
                    enqueue({
                        groupJid,
                        key: oldestMsg.key,
                        timestamp: oldestTs,
                        mode: 'gap',
                    })
                    continue
                }
                // initial
                if (oldestTs <= floor) {
                    finish(groupJid, 'initial-floor-reached')
                    continue
                }
                if (shortPage) {
                    await continueOrFinishIncomplete(
                        groupJid,
                        oldestMsg,
                        oldestTs,
                        'initial',
                        'short-page'
                    )
                    continue
                }
                enqueue({
                    groupJid,
                    key: oldestMsg.key,
                    timestamp: oldestTs,
                    mode: 'initial',
                })
                continue
            }

            // Bulk history: gap or deepen toward sticky floor.
            const latest = await getLatestGroupMessage(groupJid)
            const head = headAnchor(groupJid)
            if (
                head &&
                latest &&
                head.timestamp > latest.timestamp + 2 &&
                head.key.id !== latest.messageId
            ) {
                gapTargetTs.set(groupJid, latest.timestamp)
                enqueue({
                    groupJid,
                    key: head.key,
                    timestamp: head.timestamp,
                    mode: 'gap',
                })
                continue
            }
            if (oldestTs > floor) {
                enqueue({
                    groupJid,
                    key: oldestMsg.key,
                    timestamp: oldestTs,
                    mode: 'initial',
                })
            }
        }
    }

    return {
        setTrackedGroups(jids: string[]) {
            const fresh = jids.filter((jid) => !trackedJids.includes(jid))
            trackedJids = [...new Set([...trackedJids, ...jids])]
            for (const jid of jids) {
                finished.delete(jid)
                void ensureGroupHistoryFloor(jid, defaultFloor).then((floor) => {
                    floorCache.set(jid, floor)
                })
            }
            if (allowingRequests) void enqueueTrackedCatchup()
            else if (fresh.length > 0) scheduleSettle('tracked')
        },
        noteConnected() {
            finished.clear()
            pages.clear()
            gapTargetTs.clear()
            fetchAttempts.clear()
            incompleteAttempts.clear()
            scheduleSettle('connected')
        },
        noteChatHead(m: WAMessage) {
            const groupJid = m.key.remoteJid
            if (!groupJid || !isJidGroup(groupJid) || !m.key.id) return
            const timestamp = unixSeconds(m.messageTimestamp)
            const previous = chatHeads.get(groupJid)
            const previousTs = previous ? unixSeconds(previous.messageTimestamp) : 0
            if (!previous || timestamp >= previousTs) {
                chatHeads.set(groupJid, m)
            }
            if (trackedJids.includes(groupJid) && !finished.has(groupJid) && allowingRequests) {
                void enqueueCatchupForGroup(groupJid)
            }
        },
        noteHistoryChunk(syncType?: unknown) {
            if (!isBulkHistorySync(syncType)) return
            seenBulkHistory = true
            scheduleSettle('history.chunk')
        },
        noteHistoryStatus(syncType: unknown, status?: string) {
            if (!isBulkHistorySync(syncType)) return
            seenBulkHistory = true
            scheduleSettle(status === 'paused' ? 'history.paused' : 'history.complete')
        },
        considerMessage,
        considerHistoryBatch,
        stop() {
            stopped = true
            allowingRequests = false
            jobs.clear()
            clearSettleTimer()
        },
    }
}

/** Re-export for ingest cutoff helpers. */
export async function resolveHistoryFloor(groupJid: string): Promise<number> {
    const existing = await getGroupHistoryFloor(groupJid)
    if (existing !== undefined) return existing
    const floor = Math.floor(Date.now() / 1000) - config.catchupBackfillSeconds
    return ensureGroupHistoryFloor(groupJid, floor)
}
