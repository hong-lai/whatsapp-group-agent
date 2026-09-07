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
import { getLatestGroupMessage, getOldestGroupMessage, type LatestGroupMessage } from './db.js'
import { log } from './log.js'
import { settleDelayMs, waitHistoryRequest } from './rateLimit.js'

function isBackfillReason(reason: string): boolean {
    return reason === 'tracked-backfill' || reason === 'on_demand_continue'
}

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
    const windowStart = Math.floor(Date.now() / 1000) - config.catchupWindowSeconds
    const backfillUntil = Math.floor(Date.now() / 1000) - config.catchupBackfillSeconds
    const pages = new Map<string, number>()
    const jobs = new Map<string, CatchupJob>()
    const awaitingOnDemand = new Set<string>()
    const pendingPdoOrder: string[] = []
    const backfillFinished = new Set<string>()
    const pdoAttempts = new Map<string, number>()
    const chatHeads = new Map<string, { key: WAMessageKey; timestamp: number }>()
    let trackedJids: string[] = []
    let seenBulkHistory = false
    const startedAt = Date.now()
    let allowingRequests = false
    let draining = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    function pageLimit(reason: string): number {
        return isBackfillReason(reason) ? config.catchupBackfillMaxPages : config.catchupMaxPages
    }

    async function isTrackedGroup(groupJid: string): Promise<boolean> {
        const cached = await getGroupMetadata(groupJid)
        return cached ? matchesGroupPattern(cached.subject) : false
    }

    function finishBackfill(groupJid: string, why: string): void {
        awaitingOnDemand.delete(groupJid)
        const index = pendingPdoOrder.indexOf(groupJid)
        if (index >= 0) pendingPdoOrder.splice(index, 1)
        backfillFinished.add(groupJid)
        log.info({ groupJid, why }, 'catchup.backfill_complete')
    }

    function rememberPendingPdo(groupJid: string): void {
        if (!awaitingOnDemand.has(groupJid)) pendingPdoOrder.push(groupJid)
        awaitingOnDemand.add(groupJid)
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
        for (const groupJid of trackedJids) {
            if (backfillFinished.has(groupJid) || jobs.has(groupJid) || awaitingOnDemand.has(groupJid)) {
                continue
            }
            const attempts = pdoAttempts.get(groupJid) ?? 0
            if (attempts >= config.catchupBackfillMaxPages) continue
            const page = pages.get(groupJid) ?? 0
            if (page >= config.catchupBackfillMaxPages) continue
            const oldest = await getOldestGroupMessage(groupJid)
            const latest = await getLatestGroupMessage(groupJid)
            const head = chatHeads.get(groupJid)
            if (
                head?.key.id &&
                head.timestamp > backfillUntil &&
                (!latest || head.timestamp > latest.timestamp + 2)
            ) {
                enqueue({
                    groupJid,
                    key: head.key,
                    timestamp: head.timestamp,
                    reason: 'tracked-backfill',
                })
                continue
            }
            if (!oldest?.messageId) continue
            if (oldest.timestamp <= backfillUntil) {
                finishBackfill(
                    groupJid,
                    latest && latest.timestamp < backfillUntil ? 'inactive' : 'already-covers-window'
                )
                continue
            }
            enqueue({
                groupJid,
                key: historyKeyFromStored(groupJid, oldest),
                timestamp: oldest.timestamp,
                reason: 'tracked-backfill',
            })
        }
    }

    async function requestFromAnchor(job: CatchupJob): Promise<'done' | 'retry'> {
        const { groupJid, key, timestamp, reason } = job
        const outsideNotifyWindow = !isBackfillReason(reason) && timestamp < windowStart
        const page = pages.get(groupJid) ?? 0
        if (!key.id || outsideNotifyWindow) return 'done'
        if (page >= pageLimit(reason)) return 'done'
        if (isBackfillReason(reason) && timestamp <= backfillUntil) return 'done'

        try {
            const latest = await getLatestGroupMessage(groupJid)
            const coversAnchor = Boolean(latest && latest.timestamp >= timestamp - 2)
            if (coversAnchor && !isBackfillReason(reason)) return 'done'

            const waitedMs = await waitHistoryRequest()
            if (stopped) return 'done'
            if (!allowingRequests) return 'retry'

            await sock.fetchMessageHistory(config.catchupPageSize, key, timestamp * 1000)
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
                    backfillUntil,
                    fromMe: key.fromMe,
                },
                'catchup.history_requested'
            )
            return 'done'
        } catch (err) {
            log.warn({ err, groupJid, messageId: key.id, reason }, 'catchup.history_request_failed')
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
        if (!isBackfillReason(job.reason) && job.timestamp < windowStart) return
        if (isBackfillReason(job.reason) && job.timestamp <= backfillUntil) return
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
        if (timestamp < windowStart) return

        const previous = await getLatestGroupMessage(groupJid)
        if (previous && previous.messageId === m.key.id) return
        if (previous && previous.timestamp >= timestamp - 2) return

        enqueue({ groupJid, key: m.key, timestamp, reason })
    }

    async function considerHistoryBatch(
        messages: WAMessage[],
        syncType: unknown,
        latestBefore: Map<string, number | undefined>
    ): Promise<void> {
        if (stopped || !isMessageHistorySync(syncType)) return
        const onDemand =
            historySyncNumber(syncType) === proto.HistorySync.HistorySyncType.ON_DEMAND
        if (onDemand && messages.length === 0) {
            const groupJid = pendingPdoOrder[0]
            if (groupJid) finishBackfill(groupJid, 'empty-on-demand')
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
                awaitingOnDemand.delete(groupJid)
                const pendingIndex = pendingPdoOrder.indexOf(groupJid)
                if (pendingIndex >= 0) pendingPdoOrder.splice(pendingIndex, 1)
                pages.set(groupJid, (pages.get(groupJid) ?? 0) + 1)
            }
            if (!(await isTrackedGroup(groupJid))) continue
            list.sort(
                (left, right) => unixSeconds(left.messageTimestamp) - unixSeconds(right.messageTimestamp)
            )
            const oldest = list[0]
            if (!oldest?.key.id) continue
            const oldestTs = unixSeconds(oldest.messageTimestamp)
            if (onDemand) {
                const reachedWindow = oldestTs <= backfillUntil
                const lastPage = list.length < config.catchupPageSize
                if (reachedWindow || lastPage) {
                    finishBackfill(groupJid, reachedWindow ? 'reached-window' : 'short-page')
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
            if (oldestTs < windowStart) continue
            const previousTs = latestBefore.get(groupJid)
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
        windowStart,
        setTrackedGroups(jids: string[]) {
            trackedJids = [...new Set([...trackedJids, ...jids])]
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
            clearSettleTimer()
        },
    }
}
