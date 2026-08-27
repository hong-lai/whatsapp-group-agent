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
    getGroupCatchup,
    getLatestGroupMessage,
    getOldestGroupMessage,
    groupMatchesPattern,
    hasMessage,
    saveGroupCatchupHead,
    updateGroupCatchup,
    type LatestGroupMessage,
} from './db.js'
import { log } from './log.js'
import { retryBackoffMs, settleDelayMs, waitHistoryRequest } from './rateLimit.js'

type CatchupMode = 'gap' | 'backfill'

type CatchupJob = {
    groupJid: string
    key: WAMessageKey
    timestamp: number
    mode: CatchupMode
    overlapUntil?: number | undefined
    attempts: number
    retryAt?: number | undefined
}

type PendingOnDemand = {
    groupJid: string
    mode: CatchupMode
    overlapUntil?: number | undefined
}

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

function isBulkHistorySync(syncType: unknown): boolean {
    const n = historySyncNumber(syncType)
    return (
        n === proto.HistorySync.HistorySyncType.FULL ||
        n === proto.HistorySync.HistorySyncType.RECENT
    )
}

function shouldSettleOnSyncStatus(syncType: unknown): boolean {
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
    const backfillUntil = Math.floor(Date.now() / 1000) - config.catchupBackfillSeconds
    const pages = new Map<string, number>()
    const jobs = new Map<string, CatchupJob>()
    const pendingByGroup = new Map<string, PendingOnDemand>()
    const pendingPdoOrder: string[] = []
    const gapFinished = new Set<string>()
    const backfillFinished = new Set<string>()
    const chatHeads = new Map<string, { key: WAMessageKey; timestamp: number }>()
    const tracked = new Set<string>()
    let seenBulkHistory = false
    const startedAt = Date.now()
    let allowingRequests = false
    let draining = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    function pageLimit(mode: CatchupMode): number {
        return mode === 'gap' ? config.catchupGapMaxPages : config.catchupBackfillMaxPages
    }

    async function isTrackedGroup(groupJid: string): Promise<boolean> {
        if (tracked.has(groupJid)) return true
        const cached = await getGroupMetadata(groupJid)
        if (cached) return matchesGroupPattern(cached.subject)
        return groupMatchesPattern(groupJid)
    }

    function rememberPending(pending: PendingOnDemand): void {
        if (!pendingByGroup.has(pending.groupJid)) pendingPdoOrder.push(pending.groupJid)
        pendingByGroup.set(pending.groupJid, pending)
    }

    function clearPending(groupJid: string): void {
        pendingByGroup.delete(groupJid)
        const index = pendingPdoOrder.indexOf(groupJid)
        if (index >= 0) pendingPdoOrder.splice(index, 1)
    }

    async function finishMode(
        groupJid: string,
        mode: CatchupMode,
        why: string,
        reenter = true
    ): Promise<void> {
        clearPending(groupJid)
        if (mode === 'gap') gapFinished.add(groupJid)
        else backfillFinished.add(groupJid)
        const bothDone = gapFinished.has(groupJid) && backfillFinished.has(groupJid)
        await updateGroupCatchup(groupJid, {
            status: bothDone ? 'complete' : mode === 'gap' ? 'backfilling' : 'complete',
            lastError: null,
            retryCount: 0,
            nextRetryAt: null,
        })
        log.info({ groupJid, mode, why }, 'catchup.mode_complete')
        if (
            reenter &&
            mode === 'gap' &&
            !backfillFinished.has(groupJid) &&
            allowingRequests
        ) {
            void enqueueTrackedBackfill()
        }
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

    function headFromCatchup(groupJid: string): { key: WAMessageKey; timestamp: number } | undefined {
        const memory = chatHeads.get(groupJid)
        if (memory?.key.id) return memory
        return undefined
    }

    async function headForGroup(groupJid: string): Promise<{ key: WAMessageKey; timestamp: number } | undefined> {
        const memory = headFromCatchup(groupJid)
        if (memory) return memory
        const stored = await getGroupCatchup(groupJid)
        if (!stored?.headMessageId || stored.headTimestamp == null) return undefined
        return {
            key: {
                remoteJid: groupJid,
                id: stored.headMessageId,
                fromMe: Boolean(stored.headFromMe),
                ...(stored.headParticipant ? { participant: stored.headParticipant } : {}),
            },
            timestamp: stored.headTimestamp,
        }
    }

    function persistHead(groupJid: string, key: WAMessageKey, timestamp: number): void {
        void saveGroupCatchupHead(groupJid, key, timestamp).catch((err) => {
            log.debug({ err, groupJid }, 'catchup.head_persist_failed')
        })
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
                await enqueueTrackedBackfill()
                log.info({ pending: jobs.size, reason }, 'catchup.ready')
                void drain()
            })()
        }, waitMs)
    }

    async function enqueueTrackedBackfill(): Promise<void> {
        if (!seenBulkHistory && Date.now() - startedAt > 180_000) {
            seenBulkHistory = true
        }
        if (!seenBulkHistory) {
            scheduleSettle('waiting-bulk-history')
            return
        }
        for (const groupJid of tracked) {
            if (jobs.has(groupJid) || pendingByGroup.has(groupJid)) continue
            const state = await getGroupCatchup(groupJid)
            if (state?.nextRetryAt && state.nextRetryAt * 1000 > Date.now()) continue

            const latest = await getLatestGroupMessage(groupJid)
            const oldest = await getOldestGroupMessage(groupJid)
            const head = await headForGroup(groupJid)

            if (!gapFinished.has(groupJid)) {
                const haveHead = Boolean(head?.key.id && (await hasMessage(head.key.id)))
                if (head?.key.id && !haveHead) {
                    enqueue({
                        groupJid,
                        key: head.key,
                        timestamp: head.timestamp,
                        mode: latest ? 'gap' : 'backfill',
                        overlapUntil: latest?.timestamp,
                        attempts: 0,
                    })
                    continue
                }
                await finishMode(groupJid, 'gap', haveHead ? 'head-already-stored' : 'no-head', false)
            }

            if (backfillFinished.has(groupJid) || jobs.has(groupJid) || pendingByGroup.has(groupJid)) {
                continue
            }
            if (!oldest?.messageId) {
                await finishMode(groupJid, 'backfill', 'no-messages', false)
                continue
            }
            if (oldest.timestamp <= backfillUntil) {
                await finishMode(
                    groupJid,
                    'backfill',
                    latest && latest.timestamp < backfillUntil ? 'inactive' : 'already-covers-window',
                    false
                )
                continue
            }
            enqueue({
                groupJid,
                key: historyKeyFromStored(groupJid, oldest),
                timestamp: oldest.timestamp,
                mode: 'backfill',
                attempts: 0,
            })
        }
    }

    async function requestFromAnchor(job: CatchupJob): Promise<'done' | 'retry' | 'wait'> {
        const { groupJid, key, timestamp, mode } = job
        const page = pages.get(groupJid) ?? 0
        if (!key.id) return 'done'
        if (page >= pageLimit(mode)) {
            await updateGroupCatchup(groupJid, {
                status: 'error',
                lastError: 'page-limit',
                nextRetryAt: Math.floor(Date.now() / 1000) + 60,
            })
            log.warn({ groupJid, mode, page }, 'catchup.page_limit')
            return 'done'
        }
        if (mode === 'backfill' && timestamp <= backfillUntil) return 'done'
        if (job.retryAt && job.retryAt > Date.now()) return 'wait'

        try {
            if (mode === 'gap' && job.overlapUntil == null) {
                const haveAnchor = await hasMessage(key.id)
                if (haveAnchor) return 'done'
            }

            const waitedMs = await waitHistoryRequest()
            if (stopped) return 'done'
            if (!allowingRequests) return 'retry'

            await sock.fetchMessageHistory(config.catchupPageSize, key, timestamp * 1000)
            rememberPending({ groupJid, mode, overlapUntil: job.overlapUntil })
            pages.set(groupJid, page + 1)
            await updateGroupCatchup(groupJid, {
                status: mode === 'gap' ? 'catching_up' : 'backfilling',
                lastError: null,
                retryCount: 0,
                nextRetryAt: null,
                incrementPages: true,
            })
            log.info(
                {
                    groupJid,
                    messageId: key.id,
                    page: page + 1,
                    mode,
                    waitedMs,
                    overlapUntil: job.overlapUntil,
                    backfillUntil,
                    fromMe: key.fromMe,
                },
                'catchup.history_requested'
            )
            return 'done'
        } catch (err) {
            const attempts = job.attempts + 1
            const waitMs = retryBackoffMs(attempts, config.historyRetryMinMs, config.historyRetryMaxMs)
            const retryAt = Date.now() + waitMs
            log.warn(
                { err, groupJid, messageId: key.id, mode, attempts, waitMs },
                'catchup.history_request_failed'
            )
            await updateGroupCatchup(groupJid, {
                status: 'error',
                lastError: String(err),
                retryCount: attempts,
                nextRetryAt: Math.floor(retryAt / 1000),
            })
            if (attempts >= config.catchupHistoryRetryMax) return 'done'
            job.attempts = attempts
            job.retryAt = retryAt
            jobs.set(groupJid, job)
            return 'wait'
        }
    }

    function nextDueJob(): CatchupJob | undefined {
        const now = Date.now()
        let soonestWait: CatchupJob | undefined
        for (const job of jobs.values()) {
            if (!job.retryAt || job.retryAt <= now) return job
            if (!soonestWait || job.retryAt < soonestWait.retryAt!) soonestWait = job
        }
        return soonestWait
    }

    function scheduleRetryWake(job: CatchupJob): void {
        if (!job.retryAt || stopped) return
        const delay = Math.max(50, job.retryAt - Date.now())
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
            retryTimer = undefined
            void drain()
        }, delay)
    }

    async function drain(): Promise<void> {
        if (draining || stopped || !allowingRequests) return
        draining = true
        try {
            while (!stopped && allowingRequests) {
                const next = nextDueJob()
                if (!next) break
                if (next.retryAt && next.retryAt > Date.now()) {
                    scheduleRetryWake(next)
                    break
                }
                const result = await requestFromAnchor(next)
                if (result === 'retry') break
                if (result === 'wait') {
                    scheduleRetryWake(next)
                    break
                }
                if (jobs.get(next.groupJid) === next) jobs.delete(next.groupJid)
            }
        } finally {
            draining = false
            if (!stopped && allowingRequests) {
                const due = nextDueJob()
                if (due && (!due.retryAt || due.retryAt <= Date.now())) void drain()
            }
        }
    }

    function enqueue(job: CatchupJob): void {
        if (stopped || !job.key.id) return
        if (job.mode === 'backfill' && job.timestamp <= backfillUntil) return
        const page = pages.get(job.groupJid) ?? 0
        if (page >= pageLimit(job.mode)) return
        const existing = jobs.get(job.groupJid)
        if (existing && existing.mode === 'gap' && job.mode === 'backfill') return
        jobs.set(job.groupJid, job)
        if (allowingRequests) void drain()
    }

    async function considerMessage(m: WAMessage, _reason: string): Promise<void> {
        const groupJid = m.key.remoteJid
        if (stopped || !groupJid || !isJidGroup(groupJid) || !m.key.id) return
        if (!(await isTrackedGroup(groupJid))) return

        const timestamp = unixSeconds(m.messageTimestamp)
        const previous = await getLatestGroupMessage(groupJid)
        if (previous && previous.messageId === m.key.id) return
        if (previous && previous.timestamp >= timestamp - 2) return
        if (await hasMessage(m.key.id)) return

        gapFinished.delete(groupJid)
        enqueue({
            groupJid,
            key: m.key,
            timestamp,
            mode: previous ? 'gap' : 'backfill',
            overlapUntil: previous?.timestamp,
            attempts: 0,
        })
    }

    async function considerHistoryBatch(
        messages: WAMessage[],
        syncType: unknown,
        latestBefore: Map<string, number | undefined>,
        preexistingIds: Set<string>
    ): Promise<void> {
        if (stopped || !isMessageHistorySync(syncType)) return
        const onDemand =
            historySyncNumber(syncType) === proto.HistorySync.HistorySyncType.ON_DEMAND
        if (onDemand && messages.length === 0) {
            const groupJid = pendingPdoOrder[0]
            if (groupJid) {
                const pending = pendingByGroup.get(groupJid)
                await finishMode(groupJid, pending?.mode ?? 'gap', 'empty-on-demand')
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
            const pending = pendingByGroup.get(groupJid)
            if (onDemand) clearPending(groupJid)
            if (!(await isTrackedGroup(groupJid))) continue
            list.sort(
                (left, right) => unixSeconds(left.messageTimestamp) - unixSeconds(right.messageTimestamp)
            )
            const oldest = list[0]
            if (!oldest?.key.id) continue
            const oldestTs = unixSeconds(oldest.messageTimestamp)
            const lastPage = list.length < config.catchupPageSize

            if (onDemand) {
                const mode = pending?.mode ?? 'gap'
                if (mode === 'gap') {
                    const overlapUntil = pending?.overlapUntil
                    const overlapped =
                        overlapUntil !== undefined &&
                        (oldestTs <= overlapUntil + 2 ||
                            list.some(
                                (message) =>
                                    Boolean(message.key.id) &&
                                    preexistingIds.has(message.key.id as string) &&
                                    unixSeconds(message.messageTimestamp) <= overlapUntil + 2
                            ))
                    if (overlapped || lastPage) {
                        await finishMode(
                            groupJid,
                            'gap',
                            overlapped ? 'reached-overlap' : 'short-page'
                        )
                        continue
                    }
                    enqueue({
                        groupJid,
                        key: oldest.key,
                        timestamp: oldestTs,
                        mode: 'gap',
                        overlapUntil,
                        attempts: 0,
                    })
                    continue
                }
                if (oldestTs <= backfillUntil || lastPage) {
                    await finishMode(
                        groupJid,
                        'backfill',
                        oldestTs <= backfillUntil ? 'reached-window' : 'short-page'
                    )
                    continue
                }
                enqueue({
                    groupJid,
                    key: oldest.key,
                    timestamp: oldestTs,
                    mode: 'backfill',
                    attempts: 0,
                })
                continue
            }

            const previousTs = latestBefore.get(groupJid)
            if (previousTs !== undefined && oldestTs > previousTs + 2) {
                gapFinished.delete(groupJid)
                enqueue({
                    groupJid,
                    key: oldest.key,
                    timestamp: oldestTs,
                    mode: 'gap',
                    overlapUntil: previousTs,
                    attempts: 0,
                })
                continue
            }
            if (previousTs === undefined && oldestTs > backfillUntil) {
                enqueue({
                    groupJid,
                    key: oldest.key,
                    timestamp: oldestTs,
                    mode: 'backfill',
                    attempts: 0,
                })
            }
        }
    }

    return {
        setTrackedGroups(jids: string[]) {
            const added: string[] = []
            for (const jid of jids) {
                if (tracked.has(jid)) continue
                tracked.add(jid)
                added.push(jid)
                gapFinished.delete(jid)
                backfillFinished.delete(jid)
            }
            if (added.length === 0) return
            for (const jid of added) {
                const head = chatHeads.get(jid)
                if (head) persistHead(jid, head.key, head.timestamp)
            }
            log.info({ added, total: tracked.size }, 'catchup.groups_tracked')
            if (seenBulkHistory) scheduleSettle('group.tracked')
        },
        noteConnected() {
            scheduleSettle('connected')
        },
        noteChatHead(m: WAMessage) {
            const groupJid = m.key.remoteJid
            if (!groupJid || !isJidGroup(groupJid) || !m.key.id) return
            const timestamp = unixSeconds(m.messageTimestamp)
            const previous = chatHeads.get(groupJid)
            if (!previous || timestamp >= previous.timestamp) {
                chatHeads.set(groupJid, { key: m.key, timestamp })
                if (tracked.has(groupJid)) persistHead(groupJid, m.key, timestamp)
            }
        },
        noteHistoryChunk(syncType?: unknown) {
            if (isBulkHistorySync(syncType)) seenBulkHistory = true
            const n = historySyncNumber(syncType)
            if (
                n === proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP ||
                n === proto.HistorySync.HistorySyncType.FULL ||
                n === proto.HistorySync.HistorySyncType.RECENT
            ) {
                scheduleSettle('history.chunk')
            }
        },
        noteHistoryStatus(syncType: unknown, status?: string) {
            if (!shouldSettleOnSyncStatus(syncType)) return
            if (isBulkHistorySync(syncType)) seenBulkHistory = true
            scheduleSettle(status === 'paused' ? 'history.paused' : 'history.complete')
        },
        considerMessage,
        considerHistoryBatch,
        stop() {
            stopped = true
            allowingRequests = false
            jobs.clear()
            pendingByGroup.clear()
            pendingPdoOrder.length = 0
            clearSettleTimer()
            if (retryTimer) clearTimeout(retryTimer)
        },
    }
}
