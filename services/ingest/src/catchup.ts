import {
    isJidGroup,
    jidNormalizedUser,
    proto,
    type WAMessage,
    type WAMessageKey,
    type WASocket,
} from '@whiskeysockets/baileys'
import {
    getAppSetting,
    getGroupMessageAfter,
    getLatestGroupMessage,
    getOldestGroupMessage,
    listMissingMediaSpans,
    setAppSetting,
    type LatestGroupMessage,
} from '../../../packages/shared/src/db/index.js'
import { log } from '../../../packages/shared/src/log.js'
import { getGroupMetadata } from './cache.js'
import { config, matchesGroupPattern } from './config.js'
import { fileTypes } from './media.js'
import { settleDelayMs, waitHistoryRequest } from './rateLimit.js'

// v2: v1 could be marked done while catchup.no_anchor left groups unfinished,
// so groups that still have missing files get one more walk.
const MEDIA_GAP_BACKFILL_KEY = 'media_gap_backfill_v2'
const MEDIA_GAP_REASON = 'media-gap'

type MediaGapTarget = {
    oldestTs: number
    newestTs: number
    missingCount: number
}

type MediaGapBackfillState = {
    done: boolean
    finishedGroups: string[]
}

function parseMediaGapState(value: unknown): MediaGapBackfillState {
    if (!value || typeof value !== 'object') return { done: false, finishedGroups: [] }
    const record = value as { done?: unknown; finishedGroups?: unknown }
    const finishedGroups = Array.isArray(record.finishedGroups)
        ? record.finishedGroups.filter((jid): jid is string => typeof jid === 'string')
        : []
    return { done: record.done === true, finishedGroups }
}

function mediaGapMessageTypes(): string[] {
    return Object.keys(fileTypes).filter((type) => type !== 'stickerMessage')
}

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
    const mediaGapTargets = new Map<string, MediaGapTarget>()
    const mediaGapFinished = new Set<string>()
    const mediaGapAwaiting = new Set<string>()
    const mediaGapOrder: string[] = []
    const mediaGapPages = new Map<string, number>()
    const mediaGapEmpty = new Map<string, number>()
    const mediaGapLastJob = new Map<string, CatchupJob>()
    const mediaGapTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const mediaGapEndings = new Map<string, string>()
    let mediaGapPersist: Promise<void> = Promise.resolve()
    let mediaGapStartPromise: Promise<void> | undefined
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
        maybeStartMediaGap()
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
                head != null &&
                Boolean(head.key.id) &&
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
                } else if (head?.key.id || Date.now() - startedAt >= 180_000 || !isReconnectSession()) {
                    // No stored message and no recent chat head. Finish once so this group
                    // does not block the one-time missing-media walk on every settle.
                    log.warn({ groupJid, hasHead: Boolean(head?.key.id) }, 'catchup.no_anchor')
                    finishBackfill(groupJid, 'no-anchor')
                } else {
                    waitingForHeads = true
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
        if (job.reason === MEDIA_GAP_REASON) return requestMediaGap(job)
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

    function nextJob(): CatchupJob | undefined {
        const pending = [...jobs.values()]
        if (pending.length === 0) return undefined
        return pending.find((job) => job.reason === MEDIA_GAP_REASON) ?? pending[0]
    }

    async function drain(): Promise<void> {
        if (draining || stopped || !allowingRequests) return
        draining = true
        try {
            while (!stopped && allowingRequests) {
                const next = nextJob()
                if (!next) break
                if (next.reason !== MEDIA_GAP_REASON && mediaGapAwaiting.size > 0) break
                const result = await requestFromAnchor(next)
                if (result === 'retry') break
                if (jobs.get(next.groupJid) === next) jobs.delete(next.groupJid)
            }
        } finally {
            draining = false
            if (!stopped && allowingRequests && jobs.size > 0) {
                const waitingOnMediaGap =
                    mediaGapAwaiting.size > 0 &&
                    ![...jobs.values()].some((job) => job.reason === MEDIA_GAP_REASON)
                if (!waitingOnMediaGap) void drain()
            }
            if (
                !stopped &&
                allowingRequests &&
                jobs.size === 0 &&
                awaitingOnDemand.size === 0 &&
                mediaGapAwaiting.size === 0
            ) {
                maybeStartMediaGap()
            }
        }
    }

    function enqueue(job: CatchupJob): void {
        if (stopped || !job.key.id) return
        if (job.reason === MEDIA_GAP_REASON) {
            const page = mediaGapPages.get(job.groupJid) ?? 0
            if (page >= config.mediaGapMaxPages) {
                finishMediaGap(job.groupJid, 'page-limit')
                return
            }
            jobs.set(job.groupJid, job)
            if (allowingRequests) void drain()
            return
        }
        if (mediaGapTargets.has(job.groupJid)) return
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
            if (mediaGapAwaiting.size > 0 && awaitingOnDemand.size === 0) {
                const groupJid = mediaGapOrder[0]
                if (!groupJid) return
                clearMediaGapWait(groupJid)
                const empties = (mediaGapEmpty.get(groupJid) ?? 0) + 1
                mediaGapEmpty.set(groupJid, empties)
                const retryJob = mediaGapLastJob.get(groupJid)
                if (empties < 2 && retryJob) {
                    log.warn({ groupJid }, 'media_gap.empty_on_demand_retry')
                    enqueue(retryJob)
                    return
                }
                finishMediaGap(groupJid, 'empty-on-demand')
                return
            }
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
            if (onDemand && mediaGapAwaiting.has(groupJid)) {
                clearMediaGapWait(groupJid)
                list.sort(
                    (left, right) => unixSeconds(left.messageTimestamp) - unixSeconds(right.messageTimestamp)
                )
                const oldest = list[0]
                const newest = list[list.length - 1]
                if (newest) rememberChatHead(newest)
                continueMediaGapPage(groupJid, oldest, list.length)
                continue
            }
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

    function clearMediaGapWait(groupJid: string): void {
        mediaGapAwaiting.delete(groupJid)
        const index = mediaGapOrder.indexOf(groupJid)
        if (index >= 0) mediaGapOrder.splice(index, 1)
        const timer = mediaGapTimers.get(groupJid)
        if (timer) clearTimeout(timer)
        mediaGapTimers.delete(groupJid)
    }

    function rememberMediaGapWait(groupJid: string): void {
        if (!mediaGapAwaiting.has(groupJid)) mediaGapOrder.push(groupJid)
        mediaGapAwaiting.add(groupJid)
        const existing = mediaGapTimers.get(groupJid)
        if (existing) clearTimeout(existing)
        mediaGapTimers.set(
            groupJid,
            setTimeout(() => {
                mediaGapTimers.delete(groupJid)
                if (stopped || !mediaGapAwaiting.has(groupJid)) return
                log.warn({ groupJid }, 'media_gap.awaiting_timeout')
                finishMediaGap(groupJid, 'awaiting-timeout')
            }, AWAITING_TIMEOUT_MS)
        )
    }

    function pokeDrain(): void {
        if (stopped || !allowingRequests || jobs.size === 0) return
        const waitingOnMediaGap =
            mediaGapAwaiting.size > 0 &&
            ![...jobs.values()].some((job) => job.reason === MEDIA_GAP_REASON)
        if (!waitingOnMediaGap) void drain()
    }

    function scheduleMediaGapPersist(done: boolean): void {
        const finishedGroups = [...mediaGapFinished]
        mediaGapPersist = mediaGapPersist
            .then(async () => {
                await setAppSetting(MEDIA_GAP_BACKFILL_KEY, {
                    done,
                    finishedGroups,
                    at: Date.now(),
                })
                if (done) log.info({ groups: finishedGroups.length }, 'media_gap.complete')
            })
            .catch((err) => {
                log.warn({ err }, 'media_gap.persist_failed')
            })
    }

    function finishMediaGap(groupJid: string, why: string): void {
        clearMediaGapWait(groupJid)
        mediaGapTargets.delete(groupJid)
        mediaGapEndings.set(groupJid, why)
        const retryLater = why === 'awaiting-timeout' || why === 'request-failed'
        if (!retryLater) mediaGapFinished.add(groupJid)
        log.info({ groupJid, why, remaining: mediaGapTargets.size }, 'media_gap.group_complete')
        if (mediaGapTargets.size > 0) {
            if (!retryLater) scheduleMediaGapPersist(false)
            pokeDrain()
            return
        }
        const retry = [...mediaGapEndings.values()].some(
            (ending) => ending === 'awaiting-timeout' || ending === 'request-failed'
        )
        scheduleMediaGapPersist(!retry && !stopped)
        pokeDrain()
    }

    function continueMediaGapPage(groupJid: string, oldest: WAMessage | undefined, count: number): void {
        const page = (mediaGapPages.get(groupJid) ?? 0) + 1
        mediaGapPages.set(groupJid, page)
        const target = mediaGapTargets.get(groupJid)
        const oldestTs = oldest ? unixSeconds(oldest.messageTimestamp) : 0
        const lastPage = count < config.catchupPageSize
        if (!target || !oldest?.key.id) {
            finishMediaGap(groupJid, 'no-target')
            return
        }
        if (oldestTs <= target.oldestTs) {
            finishMediaGap(groupJid, 'reached-gap')
            return
        }
        if (lastPage) {
            finishMediaGap(groupJid, 'short-page')
            return
        }
        if (page >= config.mediaGapMaxPages) {
            log.warn(
                {
                    groupJid,
                    page,
                    oldestTs,
                    oldestTarget: target.oldestTs,
                    missing: target.missingCount,
                },
                'media_gap.page_limit'
            )
            finishMediaGap(groupJid, 'page-limit')
            return
        }
        enqueue({
            groupJid,
            key: oldest.key,
            timestamp: oldestTs,
            reason: MEDIA_GAP_REASON,
        })
    }

    async function requestMediaGap(job: CatchupJob): Promise<'done' | 'retry'> {
        const { groupJid, key, timestamp } = job
        const page = mediaGapPages.get(groupJid) ?? 0
        if (!key.id) {
            finishMediaGap(groupJid, 'no-anchor')
            return 'done'
        }
        if (page >= config.mediaGapMaxPages) {
            finishMediaGap(groupJid, 'page-limit')
            return 'done'
        }
        mediaGapLastJob.set(groupJid, job)
        try {
            const waitedMs = await waitHistoryRequest()
            if (stopped) return 'done'
            if (!allowingRequests) return 'retry'
            await sock.fetchMessageHistory(config.catchupPageSize, key, timestamp * 1000)
            rememberMediaGapWait(groupJid)
            const target = mediaGapTargets.get(groupJid)
            log.info(
                {
                    groupJid,
                    messageId: key.id,
                    page: page + 1,
                    waitedMs,
                    oldestTarget: target?.oldestTs,
                    missing: target?.missingCount,
                },
                'media_gap.history_requested'
            )
            return 'done'
        } catch (err) {
            log.warn({ err, groupJid, messageId: key.id }, 'media_gap.history_request_failed')
            finishMediaGap(groupJid, 'request-failed')
            return 'done'
        }
    }

    function maybeStartMediaGap(): void {
        if (mediaGapStartPromise || stopped || !allowingRequests) return
        if (config.skipMediaDownload) return
        if (jobs.size > 0 || awaitingOnDemand.size > 0 || mediaGapAwaiting.size > 0) return
        if (trackedJids.length === 0) return
        if (trackedJids.some((jid) => !backfillFinished.has(jid))) return
        mediaGapStartPromise = startMediaGap().catch((err) => {
            log.warn({ err }, 'media_gap.start_failed')
            if (mediaGapTargets.size === 0) mediaGapStartPromise = undefined
        })
    }

    async function startMediaGap(): Promise<void> {
        const state = parseMediaGapState(await getAppSetting(MEDIA_GAP_BACKFILL_KEY))
        if (state.done) {
            log.info('media_gap.already_done')
            return
        }
        if (stopped || jobs.size > 0 || awaitingOnDemand.size > 0 || !allowingRequests) {
            mediaGapStartPromise = undefined
            return
        }
        for (const groupJid of state.finishedGroups) mediaGapFinished.add(groupJid)
        const pendingJids = trackedJids.filter((jid) => !mediaGapFinished.has(jid))
        const spans = await listMissingMediaSpans(pendingJids, mediaGapMessageTypes())
        if (stopped || jobs.size > 0 || awaitingOnDemand.size > 0 || !allowingRequests) {
            mediaGapStartPromise = undefined
            return
        }
        if (spans.length === 0) {
            scheduleMediaGapPersist(true)
            log.info({ skippedGroups: mediaGapFinished.size }, 'media_gap.nothing_missing')
            return
        }
        const missing = spans.reduce((sum, span) => sum + span.missingCount, 0)
        log.info({ groups: spans.length, missing }, 'media_gap.start')
        for (const span of spans) {
            mediaGapTargets.set(span.groupJid, {
                oldestTs: span.oldestTimestamp,
                newestTs: span.newestTimestamp,
                missingCount: span.missingCount,
            })
        }
        for (const span of spans) {
            const newer = await getGroupMessageAfter(span.groupJid, span.newestTimestamp)
            const head = chatHeads.get(span.groupJid)
            const storedAnchor: LatestGroupMessage = newer ?? {
                messageId: span.newestMessageId,
                senderJid: span.newestSenderJid,
                timestamp: span.newestTimestamp,
            }
            const headIsNewer = Boolean(head?.key.id && head.timestamp > span.newestTimestamp)
            const key = headIsNewer && head ? head.key : historyKeyFromStored(span.groupJid, storedAnchor)
            const timestamp = headIsNewer && head ? head.timestamp : storedAnchor.timestamp
            if (!key.id) {
                finishMediaGap(span.groupJid, 'no-anchor')
                continue
            }
            log.info(
                {
                    groupJid: span.groupJid,
                    messageId: key.id,
                    missing: span.missingCount,
                    oldestTarget: span.oldestTimestamp,
                    tip: !newer && !headIsNewer,
                    anchor: headIsNewer ? 'chat-head' : newer ? 'newer-message' : 'missing-message',
                },
                'media_gap.anchored'
            )
            enqueue({
                groupJid: span.groupJid,
                key,
                timestamp,
                reason: MEDIA_GAP_REASON,
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
            for (const groupJid of [...mediaGapAwaiting]) clearMediaGapWait(groupJid)
        },
    }
}
