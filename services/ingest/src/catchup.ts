import {
    isJidGroup,
    jidNormalizedUser,
    proto,
    type WAMessage,
    type WAMessageKey,
    type WASocket,
} from '@whiskeysockets/baileys'
import { getLatestGroupMessage, getOldestGroupMessage, type LatestGroupMessage } from '../../../packages/shared/src/db/index.js'
import { log } from '../../../packages/shared/src/log.js'
import { getGroupMetadata } from './cache.js'
import { config, matchesGroupPattern } from './config.js'
import { settleDelayMs, waitHistoryRequest } from './rateLimit.js'

function isBackfillReason(reason: string): boolean {
    return reason === 'tracked-backfill' || reason === 'on_demand_continue'
}

const AWAITING_TIMEOUT_MS = 90_000

type CatchupJob = {
    groupJid: string
    key: WAMessageKey
    timestamp: number
    reason: string
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
        n === proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP ||
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

export function asCatchupMessage(value: unknown): WAMessage | undefined {
    if (!value || typeof value !== 'object') return undefined
    const record = value as { key?: WAMessageKey | null; message?: { key?: WAMessageKey | null } }
    if (record.key?.id) return record as WAMessage
    if (record.message && typeof record.message === 'object' && record.message.key?.id) {
        return record.message as WAMessage
    }
    return undefined
}

export function createCatchup(sock: WASocket, opts: { existingSession?: boolean } = {}) {
    const pages = new Map<string, number>()
    const jobs = new Map<string, CatchupJob>()
    const awaitingOnDemand = new Set<string>()
    const pendingPdoOrder: string[] = []
    const backfillFinished = new Set<string>()
    const pdoAttempts = new Map<string, number>()
    const fetchAttempts = new Map<string, number>()
    const awaitingSince = new Map<string, number>()
    const chatHeads = new Map<string, { key: WAMessageKey; timestamp: number }>()
    const storedAtConnect = new Map<string, number>()
    let trackedJids: string[] = []
    let seenBulkHistory = false
    const existingSession = Boolean(opts.existingSession)
    const startedAt = Date.now()
    let allowingRequests = false
    let draining = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    function notifyFloor(): number {
        return Math.floor(Date.now() / 1000) - config.catchupWindowSeconds
    }

    function backfillFloor(): number {
        return Math.floor(Date.now() / 1000) - config.catchupBackfillSeconds
    }

    function pageLimit(reason: string): number {
        return isBackfillReason(reason) ? config.catchupBackfillMaxPages : config.catchupMaxPages
    }

    async function isTrackedGroup(groupJid: string): Promise<boolean> {
        if (trackedJids.includes(groupJid)) return true
        const cached = await getGroupMetadata(groupJid)
        return cached ? matchesGroupPattern(cached.subject) : false
    }

    function clearAwaiting(groupJid: string): void {
        awaitingOnDemand.delete(groupJid)
        awaitingSince.delete(groupJid)
        const index = pendingPdoOrder.indexOf(groupJid)
        if (index >= 0) pendingPdoOrder.splice(index, 1)
    }

    function finishBackfill(groupJid: string, why: string): void {
        clearAwaiting(groupJid)
        fetchAttempts.delete(groupJid)
        backfillFinished.add(groupJid)
        log.info({ groupJid, why, backfillUntil: backfillFloor() }, 'catchup.backfill_complete')
    }

    function rememberPendingPdo(groupJid: string): void {
        if (!awaitingOnDemand.has(groupJid)) pendingPdoOrder.push(groupJid)
        awaitingOnDemand.add(groupJid)
        awaitingSince.set(groupJid, Date.now())
    }

    function rememberChatHead(m: WAMessage): void {
        const groupJid = m.key.remoteJid
        if (!groupJid || !isJidGroup(groupJid) || !m.key.id) return
        const timestamp = unixSeconds(m.messageTimestamp)
        const previous = chatHeads.get(groupJid)
        if (!previous || timestamp >= previous.timestamp) {
            chatHeads.set(groupJid, { key: m.key, timestamp })
        }
    }

    function releaseStaleAwaiting(): void {
        const now = Date.now()
        for (const groupJid of [...awaitingOnDemand]) {
            const since = awaitingSince.get(groupJid) ?? now
            if (now - since < AWAITING_TIMEOUT_MS) continue
            log.warn({ groupJid, waitedMs: now - since }, 'catchup.awaiting_timeout')
            clearAwaiting(groupJid)
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

    function clearSettleTimer(): void {
        if (settleTimer) {
            clearTimeout(settleTimer)
            settleTimer = undefined
        }
    }

    function isReconnectSession(): boolean {
        return existingSession
    }

    function scheduleSettle(reason: string): void {
        if (stopped) return
        const keepDraining =
            isReconnectSession() &&
            (reason === 'waiting-bulk-history' || reason === 'waiting-chat-heads')
        if (!keepDraining) allowingRequests = false
        clearSettleTimer()
        const waitMs = settleDelayMs()
        log.debug({ waitMs, reason, pending: jobs.size }, 'catchup.settling')
        settleTimer = setTimeout(() => {
            void (async () => {
                if (stopped) return
                allowingRequests = true
                await enqueueTrackedBackfill()
                if (reason !== 'waiting-bulk-history' && reason !== 'waiting-chat-heads') {
                    log.info(
                        {
                            pending: jobs.size,
                            reason,
                            backfillUntil: backfillFloor(),
                            backfillSeconds: config.catchupBackfillSeconds,
                        },
                        'catchup.ready'
                    )
                }
                void drain()
            })()
        }, waitMs)
        if (keepDraining && allowingRequests) void drain()
    }

    async function enqueueTrackedBackfill(): Promise<void> {
        if (!seenBulkHistory && Date.now() - startedAt > 180_000) {
            seenBulkHistory = true
            log.info('catchup.bulk_history_timeout')
        }
        if (!seenBulkHistory && isReconnectSession()) {
            seenBulkHistory = true
            log.info('catchup.reconnect_skip_bulk_wait')
        }
        if (!seenBulkHistory) {
            scheduleSettle('waiting-bulk-history')
            return
        }
        releaseStaleAwaiting()
        const until = backfillFloor()
        let waitingForHeads = false
        for (const groupJid of trackedJids) {
            if (backfillFinished.has(groupJid) || jobs.has(groupJid) || awaitingOnDemand.has(groupJid)) {
                continue
            }
            const attempts = pdoAttempts.get(groupJid) ?? 0
            if (attempts >= config.catchupBackfillMaxPages) {
                finishBackfill(groupJid, 'page-limit')
                continue
            }
            const page = pages.get(groupJid) ?? 0
            if (page >= config.catchupBackfillMaxPages) {
                finishBackfill(groupJid, 'page-limit')
                continue
            }
            const oldest = await getOldestGroupMessage(groupJid)
            const latest = await getLatestGroupMessage(groupJid)
            const head = chatHeads.get(groupJid)
            const knownAtConnect = storedAtConnect.get(groupJid) ?? 0
            const reconnectHole =
                knownAtConnect > 0 &&
                Boolean(head?.key.id) &&
                head.timestamp > until &&
                head.timestamp > knownAtConnect + 2
            if (reconnectHole && head?.key.id) {
                enqueue({
                    groupJid,
                    key: head.key,
                    timestamp: head.timestamp,
                    reason: 'tracked-backfill',
                })
                continue
            }
            if (!oldest?.messageId) {
                if (head?.key.id && head.timestamp > until) {
                    enqueue({
                        groupJid,
                        key: head.key,
                        timestamp: head.timestamp,
                        reason: 'tracked-backfill',
                    })
                } else {
                    log.warn({ groupJid }, 'catchup.no_anchor')
                }
                continue
            }
            if (oldest.timestamp <= until) {
                if (latest && latest.timestamp < until) {
                    finishBackfill(groupJid, 'inactive')
                    continue
                }
                if (head?.key.id || Date.now() - startedAt >= 180_000 || !isReconnectSession()) {
                    finishBackfill(groupJid, 'already-covers-window')
                    continue
                }
                waitingForHeads = true
                continue
            }
            enqueue({
                groupJid,
                key: historyKeyFromStored(groupJid, oldest),
                timestamp: oldest.timestamp,
                reason: 'tracked-backfill',
            })
        }
        if (waitingForHeads) scheduleSettle('waiting-chat-heads')
    }

    async function requestFromAnchor(job: CatchupJob): Promise<'done' | 'retry'> {
        const { groupJid, key, timestamp, reason } = job
        const outsideNotifyWindow = !isBackfillReason(reason) && timestamp < notifyFloor()
        const page = pages.get(groupJid) ?? 0
        if (!key.id || outsideNotifyWindow) return 'done'
        if (page >= pageLimit(reason)) return 'done'
        if (isBackfillReason(reason) && timestamp <= backfillFloor()) return 'done'

        try {
            const latest = await getLatestGroupMessage(groupJid)
            const coversAnchor = Boolean(latest && latest.timestamp >= timestamp - 2)
            if (coversAnchor && !isBackfillReason(reason)) return 'done'

            const waitedMs = await waitHistoryRequest()
            if (stopped) return 'done'
            if (!allowingRequests) return 'retry'

            await sock.fetchMessageHistory(config.catchupPageSize, key, timestamp * 1000)
            fetchAttempts.delete(groupJid)
            if (isBackfillReason(reason)) {
                rememberPendingPdo(groupJid)
                if (reason === 'tracked-backfill') {
                    pdoAttempts.set(groupJid, (pdoAttempts.get(groupJid) ?? 0) + 1)
                }
            } else {
                pages.set(groupJid, page + 1)
            }
            log.info(
                {
                    groupJid,
                    messageId: key.id,
                    page: page + 1,
                    reason,
                    waitedMs,
                    backfillUntil: backfillFloor(),
                    fromMe: key.fromMe,
                },
                'catchup.history_requested'
            )
            return 'done'
        } catch (err) {
            const attempts = (fetchAttempts.get(groupJid) ?? 0) + 1
            fetchAttempts.set(groupJid, attempts)
            log.warn(
                { err, groupJid, messageId: key.id, reason, attempts },
                'catchup.history_request_failed'
            )
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
                if (result === 'retry') break
                if (jobs.get(next.groupJid) === next) jobs.delete(next.groupJid)
            }
        } finally {
            draining = false
            if (!stopped && allowingRequests && jobs.size > 0) void drain()
        }
    }

    function enqueue(job: CatchupJob): void {
        if (stopped || !job.key.id) return
        if (!isBackfillReason(job.reason) && job.timestamp < notifyFloor()) return
        if (isBackfillReason(job.reason) && job.timestamp <= backfillFloor()) return
        const page = pages.get(job.groupJid) ?? 0
        if (page >= pageLimit(job.reason)) return
        jobs.set(job.groupJid, job)
        if (allowingRequests) void drain()
    }

    async function considerMessage(m: WAMessage, reason: string): Promise<void> {
        const groupJid = m.key.remoteJid
        if (stopped || !groupJid || !isJidGroup(groupJid) || !m.key.id) return
        if (!(await isTrackedGroup(groupJid))) return

        const timestamp = unixSeconds(m.messageTimestamp)
        if (timestamp <= backfillFloor()) return

        const previous = await getLatestGroupMessage(groupJid)
        if (previous && previous.messageId === m.key.id) return
        if (previous && previous.timestamp >= timestamp - 2) return

        const jumpSeconds = previous ? timestamp - previous.timestamp : Number.POSITIVE_INFINITY
        const reconnectGap = jumpSeconds > config.catchupWindowSeconds
        const needsBackfill = !backfillFinished.has(groupJid) || reconnectGap
        if (!needsBackfill && timestamp < notifyFloor()) return

        const existing = jobs.get(groupJid)
        if (existing && existing.timestamp >= timestamp) return

        enqueue({
            groupJid,
            key: m.key,
            timestamp,
            reason: needsBackfill ? 'tracked-backfill' : reason,
        })
    }

    async function considerHistoryBatch(
        messages: WAMessage[],
        syncType: unknown,
        latestBefore: Map<string, number | undefined>
    ): Promise<void> {
        if (stopped || !isMessageHistorySync(syncType)) return
        const onDemand =
            historySyncNumber(syncType) === proto.HistorySync.HistorySyncType.ON_DEMAND
        const until = backfillFloor()
        if (onDemand && messages.length === 0) {
            const groupJid = pendingPdoOrder[0]
            if (!groupJid) return
            const page = pages.get(groupJid) ?? 0
            if (page > 0) {
                finishBackfill(groupJid, 'empty-on-demand')
            } else {
                log.warn({ groupJid }, 'catchup.empty_on_demand_retry')
                clearAwaiting(groupJid)
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
            if (onDemand) {
                clearAwaiting(groupJid)
                pages.set(groupJid, (pages.get(groupJid) ?? 0) + 1)
            }
            if (!(await isTrackedGroup(groupJid))) continue
            list.sort(
                (left, right) => unixSeconds(left.messageTimestamp) - unixSeconds(right.messageTimestamp)
            )
            const oldest = list[0]
            const newest = list[list.length - 1]
            if (!oldest?.key.id) continue
            if (newest) rememberChatHead(newest)
            const oldestTs = unixSeconds(oldest.messageTimestamp)
            if (onDemand) {
                const knownAtConnect = storedAtConnect.get(groupJid) ?? 0
                const reachedWindow = oldestTs <= until
                const caughtUpToStored = oldestTs <= knownAtConnect + 2
                const lastPage = list.length < config.catchupPageSize
                if (reachedWindow || caughtUpToStored) {
                    finishBackfill(groupJid, reachedWindow ? 'reached-window' : 'caught-up')
                    continue
                }
                if (lastPage && knownAtConnect <= 0) {
                    finishBackfill(groupJid, 'short-page')
                    continue
                }
                enqueue({
                    groupJid,
                    key: oldest.key,
                    timestamp: oldestTs,
                    reason: 'on_demand_continue',
                })
                continue
            }
            const previousTs = latestBefore.get(groupJid)
            const holeBeforeBatch =
                previousTs !== undefined && previousTs + 2 < oldestTs && oldestTs > until
            if (holeBeforeBatch) {
                enqueue({
                    groupJid,
                    key: oldest.key,
                    timestamp: oldestTs,
                    reason: 'tracked-backfill',
                })
                continue
            }
            if (!backfillFinished.has(groupJid)) {
                if (oldestTs <= until) continue
                enqueue({
                    groupJid,
                    key: oldest.key,
                    timestamp: oldestTs,
                    reason: 'tracked-backfill',
                })
                continue
            }
            if (oldestTs < notifyFloor()) continue
            if (previousTs !== undefined && previousTs >= oldestTs) continue
            enqueue({
                groupJid,
                key: oldest.key,
                timestamp: oldestTs,
                reason: 'history.gap',
            })
        }
    }

    return {
        get windowStart() {
            return notifyFloor()
        },
        setTrackedGroups(jids: string[]) {
            trackedJids = [...new Set([...trackedJids, ...jids])]
        },
        async snapshotStoredAnchors() {
            for (const groupJid of trackedJids) {
                if (storedAtConnect.has(groupJid)) continue
                const latest = await getLatestGroupMessage(groupJid)
                storedAtConnect.set(groupJid, latest?.timestamp ?? 0)
            }
        },
        noteConnected() {
            scheduleSettle('connected')
        },
        noteChatHead(m: WAMessage) {
            rememberChatHead(m)
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
            clearSettleTimer()
        },
    }
}
