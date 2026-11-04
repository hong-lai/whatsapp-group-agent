import {
    isJidGroup,
    jidNormalizedUser,
    proto,
    type WAMessage,
    type WAMessageKey,
    type WASocket,
} from '@whiskeysockets/baileys'
import {
    getGroupMessageAfter,
    getLatestGroupMessage,
    getOldestGroupMessage,
    listExhaustedMediaDownloadIds,
    listMissingMediaMessages,
    noteExhaustedMediaDownload,
    setAppSetting,
    type LatestGroupMessage,
} from '../../../packages/shared/src/db/index.js'
import { log } from '../../../packages/shared/src/log.js'
import { getGroupMetadata } from './cache.js'
import { config, matchesGroupPattern } from './config.js'
import { fileTypes } from './media.js'
import { settleDelayMs, waitHistoryRequest } from './rateLimit.js'

/**
 * One backward walk per group.
 *
 * Baileys only returns messages older than a real message key. After the
 * phone's history burst settles, each tracked group gets a single walk:
 *
 *   fill   — newest head is ahead of stored messages (a hole or a reconnect)
 *   extend — page back from the oldest stored message toward the 2-day floor
 *   media  — page across rows that were saved with no file
 *
 * After that walk, a live notify is saved and does not start a history request.
 * A chat head that never shows up as a notify means WhatsApp moved the head
 * without delivering the messages in between, so one fill runs back to the
 * stored neighbor. Reconnect and history batches still fill those gaps too.
 * Empty on-demand replies have no group id. An empty reply is applied only
 * when one request is in flight, which is the only time it names a group.
 * That anchor is retried once. A second empty reply ends the walk, and the
 * same message id is not requested again for the rest of the session.
 */

// v2: v1 could be marked done while no-anchor left groups unfinished.
const MEDIA_GAP_BACKFILL_KEY = 'media_gap_backfill_v2'
const AWAITING_TIMEOUT_MS = 90_000
const BULK_HISTORY_WAIT_MS = 180_000
const ADJACENT_SECONDS = 2
/** Chat head waits this long for the same id to arrive as a live notify. */
const HEAD_CONFIRM_MS = 5_000
/** Extra attempt after the first empty on-demand reply. A second empty ends the walk. */
const EMPTY_REPLY_RETRIES = 1
const LIVE_IDS_PER_GROUP = 50
const RETRY_MEDIA_LATER = new Set(['awaiting-timeout', 'request-failed', 'no-anchor', 'no-target'])

/** Ids already paged in this process. A new process may walk them again. */
const pagedMissingMediaIds = new Set<string>()

type WalkKind = 'extend' | 'fill' | 'media'

type Walk = {
    groupJid: string
    kind: WalkKind
    key: WAMessageKey
    timestamp: number
    /** Non-empty pages received for this walk. */
    pages: number
    /** Requests sent. Caps timeouts and errors. Empty replies use `emptyRetries` instead. */
    sends: number
    emptyRetries: number
    /** Hole fill: stop when a page reaches the stored message on the far side. */
    stopAt?: number
}

type MediaTarget = {
    oldestTs: number
    missingCount: number
    messages: { messageId: string; timestamp: number }[]
}

type Anchor = { key: WAMessageKey; timestamp: number }

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

function mediaMessageTypes(): string[] {
    return Object.keys(fileTypes).filter((type) => type !== 'stickerMessage')
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
    const pending = new Map<string, Walk>()
    const awaiting = new Map<string, Walk>()
    const awaitingTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const backfillDone = new Set<string>()
    const deferredHoles = new Map<string, { key: WAMessageKey; timestamp: number; stopAt: number }>()
    const deepPages = new Map<string, number>()
    const chatHeads = new Map<string, Anchor>()
    const liveMessageIds = new Map<string, string[]>()
    const headConfirms = new Map<string, { timer: ReturnType<typeof setTimeout>; messageId: string }>()
    const storedAtConnect = new Map<string, number>()
    const mediaTargets = new Map<string, MediaTarget>()
    const mediaClaimed = new Set<string>()
    const mediaEndings = new Map<string, string>()
    /** Anchors WhatsApp already answered with an empty on-demand sync. */
    const emptyAnchors = new Set<string>()
    let mediaPersist: Promise<void> = Promise.resolve()
    let exhaustedTask: Promise<Set<string>> | undefined
    let trackedJids: string[] = []
    let seenBulkHistory = false
    const existingSession = Boolean(opts.existingSession)
    const startedAt = Date.now()
    let allowingRequests = false
    let draining = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    function deepFloor(): number {
        return Math.floor(Date.now() / 1000) - config.catchupBackfillSeconds
    }

    function pageBudget(walk: Walk): number {
        return walk.kind === 'media' ? config.mediaGapMaxPages : config.catchupBackfillMaxPages
    }

    function exhaustedSet(): Promise<Set<string>> {
        exhaustedTask ??= listExhaustedMediaDownloadIds().then((ids) => new Set(ids))
        return exhaustedTask
    }

    async function isTrackedGroup(groupJid: string): Promise<boolean> {
        if (trackedJids.includes(groupJid)) return true
        const cached = await getGroupMetadata(groupJid)
        return cached ? matchesGroupPattern(cached.subject) : false
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

    function rememberChatHead(m: WAMessage): void {
        const groupJid = m.key.remoteJid
        if (!groupJid || !isJidGroup(groupJid) || !m.key.id) return
        const timestamp = unixSeconds(m.messageTimestamp)
        const previous = chatHeads.get(groupJid)
        if (!previous || timestamp >= previous.timestamp) {
            chatHeads.set(groupJid, { key: m.key, timestamp })
        }
    }

    function clearSettleTimer(): void {
        if (settleTimer) {
            clearTimeout(settleTimer)
            settleTimer = undefined
        }
    }

    function clearHeadConfirms(): void {
        for (const confirm of headConfirms.values()) clearTimeout(confirm.timer)
        headConfirms.clear()
    }

    function rememberLiveMessage(groupJid: string, messageId: string): void {
        const ids = liveMessageIds.get(groupJid) ?? []
        if (!ids.includes(messageId)) ids.push(messageId)
        while (ids.length > LIVE_IDS_PER_GROUP) ids.shift()
        liveMessageIds.set(groupJid, ids)
        const confirm = headConfirms.get(groupJid)
        if (confirm?.messageId === messageId) {
            clearTimeout(confirm.timer)
            headConfirms.delete(groupJid)
        }
    }

    function wasLiveMessage(groupJid: string, messageId: string): boolean {
        return liveMessageIds.get(groupJid)?.includes(messageId) ?? false
    }

    function clearAwaiting(groupJid: string): void {
        awaiting.delete(groupJid)
        const timer = awaitingTimers.get(groupJid)
        if (timer) clearTimeout(timer)
        awaitingTimers.delete(groupJid)
    }

    function markAwaiting(walk: Walk): void {
        if (pending.get(walk.groupJid) === walk) pending.delete(walk.groupJid)
        awaiting.set(walk.groupJid, walk)
        const existing = awaitingTimers.get(walk.groupJid)
        if (existing) clearTimeout(existing)
        awaitingTimers.set(
            walk.groupJid,
            setTimeout(() => {
                awaitingTimers.delete(walk.groupJid)
                if (stopped || !awaiting.has(walk.groupJid)) return
                if (walk.kind === 'media') {
                    log.warn({ groupJid: walk.groupJid }, 'media_gap.awaiting_timeout')
                    finishMedia(walk.groupJid, 'awaiting-timeout')
                    return
                }
                log.warn({ groupJid: walk.groupJid, waitedMs: AWAITING_TIMEOUT_MS }, 'catchup.awaiting_timeout')
                clearAwaiting(walk.groupJid)
                if (walk.stopAt !== undefined && walk.sends < pageBudget(walk)) enqueue(walk)
            }, AWAITING_TIMEOUT_MS)
        )
    }

    function anchorToken(groupJid: string, messageId: string): string {
        return `${groupJid}\0${messageId}`
    }

    function rememberEmptyAnchor(walk: Walk): void {
        if (walk.key.id) emptyAnchors.add(anchorToken(walk.groupJid, walk.key.id))
    }

    function forgetEmptyAnchor(walk: Walk): void {
        if (walk.key.id) emptyAnchors.delete(anchorToken(walk.groupJid, walk.key.id))
    }

    function isEmptyAnchor(walk: Walk): boolean {
        return Boolean(walk.key.id && emptyAnchors.has(anchorToken(walk.groupJid, walk.key.id)))
    }

    function stopEmptyAnchor(walk: Walk): void {
        log.info(
            { groupJid: walk.groupJid, messageId: walk.key.id, kind: walk.kind },
            'catchup.skip_empty_anchor'
        )
        if (walk.kind === 'media') {
            finishMedia(walk.groupJid, 'empty-on-demand')
            return
        }
        if (walk.stopAt !== undefined) {
            closeHole(walk.groupJid, 'empty-on-demand')
            return
        }
        if (!backfillDone.has(walk.groupJid)) finishBackfill(walk.groupJid, 'empty-on-demand')
    }

    function enqueue(walk: Walk): void {
        if (stopped || !walk.key.id || awaiting.has(walk.groupJid)) return
        // A fresh walk of an anchor that already came back empty would burn the
        // page budget. The one allowed retry keeps emptyRetries > 0.
        if (walk.emptyRetries === 0 && isEmptyAnchor(walk)) {
            stopEmptyAnchor(walk)
            return
        }
        if (walk.pages >= pageBudget(walk) || walk.sends >= pageBudget(walk)) {
            stopForBudget(walk)
            return
        }
        if (walk.kind !== 'media' && walk.timestamp <= deepFloor()) return
        pending.set(walk.groupJid, walk)
        if (allowingRequests) void drain()
    }

    function stopForBudget(walk: Walk): void {
        if (walk.kind === 'media') {
            finishMedia(walk.groupJid, 'page-limit')
            return
        }
        if (walk.stopAt !== undefined) {
            closeHole(walk.groupJid, 'page-limit')
            return
        }
        if (!backfillDone.has(walk.groupJid)) finishBackfill(walk.groupJid, 'page-limit')
    }

    function finishBackfill(groupJid: string, why: string): void {
        if (awaiting.get(groupJid)?.kind !== 'media') clearAwaiting(groupJid)
        if (!backfillDone.has(groupJid)) {
            backfillDone.add(groupJid)
            log.info({ groupJid, why, backfillUntil: deepFloor() }, 'catchup.backfill_complete')
        }
        if (startDeferredHole(groupJid)) return
        if (!pending.has(groupJid) && !awaiting.has(groupJid)) scheduleMedia(groupJid)
    }

    function closeHole(groupJid: string, why: string): void {
        if (awaiting.get(groupJid)?.stopAt !== undefined) clearAwaiting(groupJid)
        if (pending.get(groupJid)?.stopAt !== undefined) pending.delete(groupJid)
        log.info({ groupJid, why }, 'catchup.hole_closed')
        if (!backfillDone.has(groupJid)) {
            finishBackfill(groupJid, why)
            return
        }
        if (startDeferredHole(groupJid)) return
        if (!pending.has(groupJid) && !awaiting.has(groupJid)) scheduleMedia(groupJid)
    }

    function startDeferredHole(groupJid: string): boolean {
        const hole = deferredHoles.get(groupJid)
        if (!hole || awaiting.has(groupJid)) return false
        deferredHoles.delete(groupJid)
        enqueue(messageWalk(groupJid, 'fill', hole.key, hole.timestamp, 0, hole.stopAt))
        return pending.has(groupJid)
    }

    function rememberHole(groupJid: string, key: WAMessageKey, timestamp: number, stopAt: number): void {
        const existing = deferredHoles.get(groupJid)
        if (existing && existing.timestamp >= timestamp) return
        deferredHoles.set(groupJid, { key, timestamp, stopAt })
    }

    function scheduleSettle(reason: string): void {
        if (stopped) return
        const keepDraining =
            existingSession && (reason === 'waiting-bulk-history' || reason === 'waiting-chat-heads')
        if (!keepDraining) allowingRequests = false
        clearSettleTimer()
        const waitMs = settleDelayMs()
        log.debug({ waitMs, reason, pending: pending.size }, 'catchup.settling')
        settleTimer = setTimeout(() => {
            void (async () => {
                if (stopped) return
                allowingRequests = true
                await planTracked(reason)
            })()
        }, waitMs)
        if (keepDraining && allowingRequests) void drain()
    }

    async function planTracked(settleReason: string): Promise<void> {
        if (!seenBulkHistory && Date.now() - startedAt > BULK_HISTORY_WAIT_MS) {
            seenBulkHistory = true
            log.info('catchup.bulk_history_timeout')
        }
        if (!seenBulkHistory && existingSession) {
            seenBulkHistory = true
            log.info('catchup.reconnect_skip_bulk_wait')
        }
        if (!seenBulkHistory) {
            scheduleSettle('waiting-bulk-history')
            return
        }
        const until = deepFloor()
        let waitingForHeads = false
        for (const groupJid of [...trackedJids]) {
            if (backfillDone.has(groupJid)) {
                scheduleMedia(groupJid)
                continue
            }
            if (pending.has(groupJid) || awaiting.has(groupJid)) continue
            if ((deepPages.get(groupJid) ?? 0) >= config.catchupBackfillMaxPages) {
                finishBackfill(groupJid, 'page-limit')
                continue
            }
            const decision = await decideBackfill(groupJid, until)
            if (decision === 'wait-head') waitingForHeads = true
        }
        if (waitingForHeads) {
            scheduleSettle('waiting-chat-heads')
            return
        }
        log.info(
            {
                pending: pending.size,
                reason: settleReason,
                backfillUntil: until,
                backfillSeconds: config.catchupBackfillSeconds,
            },
            'catchup.ready'
        )
        void drain()
    }

    /** Structural backfill from what is already stored. Holes from new messages are separate. */
    async function decideBackfill(groupJid: string, until: number): Promise<'wait-head' | 'planned'> {
        const head = chatHeads.get(groupJid)
        const oldest = await getOldestGroupMessage(groupJid)
        const latest = await getLatestGroupMessage(groupJid)
        const known = storedAtConnect.get(groupJid) ?? 0
        const headAheadOfConnect = Boolean(
            known > 0 && head?.key.id && head.timestamp > until && head.timestamp > known + ADJACENT_SECONDS
        )
        if (headAheadOfConnect && head?.key.id) {
            enqueue(messageWalk(groupJid, 'fill', head.key, head.timestamp, deepPages.get(groupJid) ?? 0))
            return 'planned'
        }
        if (!oldest?.messageId) {
            if (head?.key.id && head.timestamp > until) {
                enqueue(
                    messageWalk(groupJid, 'fill', head.key, head.timestamp, deepPages.get(groupJid) ?? 0)
                )
                return 'planned'
            }
            if (head?.key.id || Date.now() - startedAt >= BULK_HISTORY_WAIT_MS || !existingSession) {
                log.warn({ groupJid, hasHead: Boolean(head?.key.id) }, 'catchup.no_anchor')
                finishBackfill(groupJid, 'no-anchor')
                return 'planned'
            }
            return 'wait-head'
        }
        if (oldest.timestamp <= until) {
            if (latest && latest.timestamp < until) {
                finishBackfill(groupJid, 'inactive')
                return 'planned'
            }
            if (head?.key.id || Date.now() - startedAt >= BULK_HISTORY_WAIT_MS || !existingSession) {
                finishBackfill(groupJid, 'already-covers-window')
                return 'planned'
            }
            return 'wait-head'
        }
        enqueue(
            messageWalk(
                groupJid,
                'extend',
                historyKeyFromStored(groupJid, oldest),
                oldest.timestamp,
                deepPages.get(groupJid) ?? 0
            )
        )
        return 'planned'
    }

    function messageWalk(
        groupJid: string,
        kind: 'extend' | 'fill',
        key: WAMessageKey,
        timestamp: number,
        pages: number,
        stopAt?: number
    ): Walk {
        const walk: Walk = {
            groupJid,
            kind,
            key,
            timestamp,
            pages,
            sends: 0,
            emptyRetries: 0,
        }
        if (stopAt !== undefined) walk.stopAt = stopAt
        return walk
    }

    async function send(walk: Walk): Promise<'sent' | 'retry' | 'kept' | 'drop'> {
        if (!walk.key.id) {
            if (walk.kind === 'media') finishMedia(walk.groupJid, 'no-anchor')
            return 'drop'
        }
        if (walk.pages >= pageBudget(walk) || walk.sends >= pageBudget(walk)) {
            stopForBudget(walk)
            return 'drop'
        }
        if (walk.kind !== 'media' && walk.timestamp <= deepFloor()) {
            finishBackfill(walk.groupJid, 'reached-window')
            return 'drop'
        }
        try {
            const waitedMs = await waitHistoryRequest()
            if (stopped) return 'drop'
            if (!allowingRequests) return 'retry'
            await sock.fetchMessageHistory(config.catchupPageSize, walk.key, walk.timestamp * 1000)
            walk.sends += 1
            markAwaiting(walk)
            if (walk.kind === 'media') {
                const target = mediaTargets.get(walk.groupJid)
                log.info(
                    {
                        groupJid: walk.groupJid,
                        messageId: walk.key.id,
                        page: walk.pages + 1,
                        waitedMs,
                        oldestTarget: target?.oldestTs,
                        missing: target?.missingCount,
                    },
                    'media_gap.history_requested'
                )
            } else {
                log.info(
                    {
                        groupJid: walk.groupJid,
                        messageId: walk.key.id,
                        page: walk.pages + 1,
                        kind: walk.kind,
                        waitedMs,
                        backfillUntil: deepFloor(),
                        fromMe: walk.key.fromMe,
                    },
                    'catchup.history_requested'
                )
            }
            return 'sent'
        } catch (err) {
            walk.sends += 1
            if (walk.kind === 'media') {
                log.warn({ err, groupJid: walk.groupJid, messageId: walk.key.id }, 'media_gap.history_request_failed')
                finishMedia(walk.groupJid, 'request-failed')
                return 'drop'
            }
            log.warn(
                { err, groupJid: walk.groupJid, messageId: walk.key.id, kind: walk.kind, sends: walk.sends },
                'catchup.history_request_failed'
            )
            if (walk.sends >= pageBudget(walk)) {
                finishBackfill(walk.groupJid, 'page-limit')
                return 'drop'
            }
            // A newer walk may have replaced this one while the request was in flight.
            if (pending.get(walk.groupJid) !== walk) return 'drop'
            pending.delete(walk.groupJid)
            pending.set(walk.groupJid, walk)
            return 'kept'
        }
    }

    async function drain(): Promise<void> {
        if (draining || stopped || !allowingRequests) return
        draining = true
        try {
            while (!stopped && allowingRequests) {
                const next = pending.values().next().value
                if (!next) break
                const result = await send(next)
                if (result === 'retry') break
                if (result === 'kept') continue
                if (pending.get(next.groupJid) === next) pending.delete(next.groupJid)
            }
        } finally {
            draining = false
            if (!stopped && allowingRequests && pending.size > 0) void drain()
            if (!stopped && allowingRequests && pending.size === 0 && awaiting.size === 0) {
                for (const groupJid of trackedJids) scheduleMedia(groupJid)
            }
        }
    }

    function onEmptyDemand(): void {
        // An empty history reply carries no group. With several requests in
        // flight it cannot be attributed, so leave them for a real page or the timeout.
        if (awaiting.size !== 1) {
            if (awaiting.size > 1) log.warn({ awaiting: awaiting.size }, 'catchup.empty_on_demand_ambiguous')
            return
        }
        const oldest = awaiting.entries().next().value
        if (!oldest) return
        const [groupJid, walk] = oldest
        clearAwaiting(groupJid)
        rememberEmptyAnchor(walk)
        // A real page already arrived, so this empty reply is the end of history,
        // not a stuck anchor. Do not spend another request on it.
        const endOfHistory = walk.kind !== 'media' && walk.pages > 0
        if (!endOfHistory) {
            walk.emptyRetries += 1
            if (walk.emptyRetries <= EMPTY_REPLY_RETRIES) {
                log.warn(
                    { groupJid, messageId: walk.key.id, kind: walk.kind, emptyRetries: walk.emptyRetries },
                    walk.kind === 'media' ? 'media_gap.empty_on_demand_retry' : 'catchup.empty_on_demand_retry'
                )
                enqueue(walk)
                return
            }
        }
        log.info(
            { groupJid, messageId: walk.key.id, kind: walk.kind, pages: walk.pages },
            'catchup.empty_on_demand'
        )
        if (walk.kind === 'media') {
            finishMedia(groupJid, 'empty-on-demand')
            return
        }
        if (walk.stopAt !== undefined) closeHole(groupJid, 'empty-on-demand')
        else finishBackfill(groupJid, 'empty-on-demand')
    }

    function continueFromPage(walk: Walk, oldest: WAMessage | undefined, count: number): void {
        forgetEmptyAnchor(walk)
        const oldestTs = oldest ? unixSeconds(oldest.messageTimestamp) : 0
        if (walk.kind === 'media') {
            continueMedia(walk, oldest, oldestTs, count)
            return
        }
        walk.pages += 1
        if (walk.stopAt === undefined && !backfillDone.has(walk.groupJid)) {
            deepPages.set(walk.groupJid, walk.pages)
        }
        if (!oldest?.key.id) {
            if (walk.stopAt !== undefined) closeHole(walk.groupJid, 'no-anchor')
            else pokeMedia(walk.groupJid)
            return
        }
        const lastPage = count < config.catchupPageSize
        const reachedWindow = oldestTs <= deepFloor()
        if (walk.stopAt !== undefined) {
            const reachedStored = oldestTs <= walk.stopAt + ADJACENT_SECONDS
            if (reachedWindow || reachedStored) {
                closeHole(walk.groupJid, reachedStored ? 'reached-stored' : 'reached-window')
                return
            }
            if (lastPage || walk.pages >= pageBudget(walk)) {
                if (walk.pages >= pageBudget(walk)) {
                    log.warn(
                        { groupJid: walk.groupJid, pages: walk.pages, oldestTs, stopAt: walk.stopAt },
                        'catchup.hole_page_limit'
                    )
                }
                closeHole(walk.groupJid, lastPage ? 'short-page' : 'page-limit')
                return
            }
            enqueue({ ...walk, key: oldest.key, timestamp: oldestTs, emptyRetries: 0 })
            return
        }
        const known = storedAtConnect.get(walk.groupJid) ?? 0
        const caughtUp = oldestTs <= known + ADJACENT_SECONDS
        if (reachedWindow || caughtUp) {
            finishBackfill(walk.groupJid, reachedWindow ? 'reached-window' : 'caught-up')
            return
        }
        if (lastPage && known <= 0) {
            finishBackfill(walk.groupJid, 'short-page')
            return
        }
        if (walk.pages >= pageBudget(walk)) {
            finishBackfill(walk.groupJid, 'page-limit')
            return
        }
        enqueue({ ...walk, key: oldest.key, timestamp: oldestTs, emptyRetries: 0 })
    }

    function queueHole(
        groupJid: string,
        key: WAMessageKey,
        timestamp: number,
        stopAt: number | undefined,
        trigger: string
    ): void {
        if (!key.id) return
        if (awaiting.has(groupJid)) {
            if (stopAt !== undefined) rememberHole(groupJid, key, timestamp, stopAt)
            return
        }
        const existing = pending.get(groupJid)
        if (existing?.kind === 'media') {
            if (stopAt !== undefined) rememberHole(groupJid, key, timestamp, stopAt)
            return
        }
        if (existing && existing.timestamp >= timestamp) return
        log.debug({ groupJid, trigger, stopAt }, 'catchup.hole')
        if (backfillDone.has(groupJid) && stopAt !== undefined) {
            enqueue(messageWalk(groupJid, 'fill', key, timestamp, 0, stopAt))
            return
        }
        enqueue(messageWalk(groupJid, 'fill', key, timestamp, deepPages.get(groupJid) ?? 0))
    }

    function scheduleHeadConfirm(groupJid: string, key: WAMessageKey, timestamp: number, stopAt: number): void {
        if (!key.id) return
        const pendingConfirm = headConfirms.get(groupJid)
        if (pendingConfirm?.messageId === key.id) return
        if (pendingConfirm) clearTimeout(pendingConfirm.timer)
        const messageId = key.id
        const anchor = { ...key }
        const timer = setTimeout(() => {
            headConfirms.delete(groupJid)
            if (stopped || wasLiveMessage(groupJid, messageId)) return
            queueHole(groupJid, anchor, timestamp, stopAt, 'chat-head')
        }, HEAD_CONFIRM_MS)
        headConfirms.set(groupJid, { timer, messageId })
    }

    async function considerMessage(m: WAMessage, reason: string): Promise<void> {
        const groupJid = m.key.remoteJid
        if (stopped || !groupJid || !isJidGroup(groupJid) || !m.key.id) return
        if (!(await isTrackedGroup(groupJid))) return
        const timestamp = unixSeconds(m.messageTimestamp)
        if (timestamp <= deepFloor()) return
        // A caught-up group already has this message from the socket. The time
        // since the previous row is silence, not a hole.
        if (reason === 'notify') {
            rememberLiveMessage(groupJid, m.key.id)
            if (backfillDone.has(groupJid)) return
        }
        const previous = await getLatestGroupMessage(groupJid)
        if (previous && (previous.messageId === m.key.id || previous.timestamp >= timestamp - ADJACENT_SECONDS)) {
            return
        }
        const stopAt = previous?.timestamp
        if (
            (reason === 'chat.upsert' || reason === 'chat.update') &&
            backfillDone.has(groupJid) &&
            stopAt !== undefined
        ) {
            if (wasLiveMessage(groupJid, m.key.id)) return
            scheduleHeadConfirm(groupJid, m.key, timestamp, stopAt)
            return
        }
        queueHole(groupJid, m.key, timestamp, stopAt, reason)
    }

    async function considerHistoryBatch(
        messages: WAMessage[],
        syncType: unknown,
        latestBefore: Map<string, number | undefined>
    ): Promise<void> {
        if (stopped || !isMessageHistorySync(syncType)) return
        const onDemand = historySyncNumber(syncType) === proto.HistorySync.HistorySyncType.ON_DEMAND
        if (onDemand && messages.length === 0) {
            onEmptyDemand()
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
            list.sort((left, right) => unixSeconds(left.messageTimestamp) - unixSeconds(right.messageTimestamp))
            const oldest = list[0]
            const newest = list[list.length - 1]
            if (newest) rememberChatHead(newest)
            const waiting = awaiting.get(groupJid)
            if (onDemand && waiting) {
                clearAwaiting(groupJid)
                continueFromPage(waiting, oldest, list.length)
                continue
            }
            if (!oldest?.key.id || !(await isTrackedGroup(groupJid))) continue
            const oldestTs = unixSeconds(oldest.messageTimestamp)
            const previousTs = latestBefore.get(groupJid)
            const holeBeforeBatch =
                previousTs !== undefined &&
                previousTs + ADJACENT_SECONDS < oldestTs &&
                oldestTs > deepFloor()
            if (backfillDone.has(groupJid)) {
                if (holeBeforeBatch && previousTs !== undefined) {
                    if (awaiting.has(groupJid) || pending.get(groupJid)?.kind === 'media') {
                        rememberHole(groupJid, oldest.key, oldestTs, previousTs)
                    } else {
                        const existing = pending.get(groupJid)
                        if (!existing || existing.timestamp < oldestTs) {
                            enqueue(messageWalk(groupJid, 'fill', oldest.key, oldestTs, 0, previousTs))
                        }
                    }
                }
                continue
            }
            if (onDemand || awaiting.has(groupJid)) continue
            if (!holeBeforeBatch || previousTs === undefined) continue
            const existing = pending.get(groupJid)
            if (existing && existing.timestamp >= oldestTs) continue
            enqueue(messageWalk(groupJid, 'fill', oldest.key, oldestTs, deepPages.get(groupJid) ?? 0))
        }
    }

    function pokeMedia(groupJid: string): void {
        if (!backfillDone.has(groupJid) || pending.has(groupJid) || awaiting.has(groupJid)) return
        scheduleMedia(groupJid)
    }

    function scheduleMedia(groupJid: string): void {
        if (stopped || config.skipMediaDownload || mediaClaimed.has(groupJid)) return
        if (!backfillDone.has(groupJid) || !allowingRequests) return
        if (pending.has(groupJid) || awaiting.has(groupJid)) return
        mediaClaimed.add(groupJid)
        void startMedia(groupJid).catch((err) => {
            log.warn({ err, groupJid }, 'media_gap.start_failed')
            if (!mediaTargets.has(groupJid) && !mediaEndings.has(groupJid)) mediaClaimed.delete(groupJid)
        })
    }

    async function startMedia(groupJid: string): Promise<void> {
        const [rows, exhausted] = await Promise.all([
            listMissingMediaMessages([groupJid], mediaMessageTypes()),
            exhaustedSet(),
        ])
        if (stopped || pending.has(groupJid) || awaiting.has(groupJid) || !backfillDone.has(groupJid)) {
            mediaClaimed.delete(groupJid)
            return
        }
        const missing = rows.filter(
            (row) => !exhausted.has(row.messageId) && !pagedMissingMediaIds.has(row.messageId)
        )
        if (rows.length === 0) {
            mediaEndings.set(groupJid, 'nothing-missing')
            log.info({ groupJid }, 'media_gap.nothing_missing')
            persistMediaIfIdle()
            return
        }
        if (missing.length === 0) {
            mediaEndings.set(groupJid, 'already-done')
            log.info({ groupJid, missing: rows.length }, 'media_gap.already_done')
            persistMediaIfIdle()
            return
        }
        const oldest = missing[0]
        const newest = missing[missing.length - 1]
        if (!oldest || !newest) {
            finishMedia(groupJid, 'no-target')
            return
        }
        mediaTargets.set(groupJid, {
            oldestTs: oldest.timestamp,
            missingCount: missing.length,
            messages: missing.map((row) => ({ messageId: row.messageId, timestamp: row.timestamp })),
        })
        const newer = await getGroupMessageAfter(groupJid, newest.timestamp)
        const head = chatHeads.get(groupJid)
        const headIsNewer = Boolean(head?.key.id && head.timestamp > newest.timestamp)
        if (!newer && !headIsNewer) {
            log.info(
                { groupJid, messageId: newest.messageId, missing: missing.length },
                'media_gap.needs_newer_anchor'
            )
            finishMedia(groupJid, 'no-anchor')
            return
        }
        const storedAnchor: LatestGroupMessage = newer ?? {
            messageId: newest.messageId,
            senderJid: newest.senderJid,
            timestamp: newest.timestamp,
        }
        const key = headIsNewer && head ? head.key : historyKeyFromStored(groupJid, storedAnchor)
        const timestamp = headIsNewer && head ? head.timestamp : storedAnchor.timestamp
        if (!key.id) {
            finishMedia(groupJid, 'no-anchor')
            return
        }
        log.info(
            {
                groupJid,
                messageId: key.id,
                missing: missing.length,
                oldestTarget: oldest.timestamp,
                anchor: headIsNewer ? 'chat-head' : 'newer-message',
            },
            'media_gap.anchored'
        )
        log.info({ groupJid, missing: missing.length }, 'media_gap.start')
        enqueue({
            groupJid,
            kind: 'media',
            key,
            timestamp,
            pages: 0,
            sends: 0,
            emptyRetries: 0,
        })
    }

    function continueMedia(walk: Walk, oldest: WAMessage | undefined, oldestTs: number, count: number): void {
        const { groupJid } = walk
        const target = mediaTargets.get(groupJid)
        const pages = walk.pages + 1
        if (!target || !oldest?.key.id) {
            finishMedia(groupJid, 'no-target')
            return
        }
        if (oldestTs <= target.oldestTs) {
            finishMedia(groupJid, 'reached-gap')
            return
        }
        if (count < config.catchupPageSize) {
            finishMedia(groupJid, 'short-page', oldestTs)
            return
        }
        if (pages >= config.mediaGapMaxPages) {
            log.warn(
                { groupJid, page: pages, oldestTs, oldestTarget: target.oldestTs, missing: target.missingCount },
                'media_gap.page_limit'
            )
            finishMedia(groupJid, 'page-limit', oldestTs)
            return
        }
        enqueue({
            ...walk,
            key: oldest.key,
            timestamp: oldestTs,
            pages,
            sends: 0,
            emptyRetries: 0,
        })
    }

    function finishMedia(groupJid: string, why: string, coveredThroughTs?: number): void {
        const target = mediaTargets.get(groupJid)
        if (awaiting.get(groupJid)?.kind === 'media') clearAwaiting(groupJid)
        if (pending.get(groupJid)?.kind === 'media') pending.delete(groupJid)
        mediaTargets.delete(groupJid)
        const retryLater = RETRY_MEDIA_LATER.has(why)
        if (!retryLater && target) {
            const covered =
                coveredThroughTs == null
                    ? target.messages
                    : target.messages.filter((message) => message.timestamp >= coveredThroughTs)
            const uncovered =
                coveredThroughTs == null
                    ? []
                    : target.messages.filter((message) => message.timestamp < coveredThroughTs)
            for (const message of covered) pagedMissingMediaIds.add(message.messageId)
            for (const message of uncovered) {
                noteExhaustedMediaDownload(message.messageId)
                void exhaustedSet().then((ids) => ids.add(message.messageId))
            }
        }
        mediaEndings.set(groupJid, why)
        log.info({ groupJid, why, remaining: mediaTargets.size }, 'media_gap.group_complete')
        persistMediaIfIdle()
        startDeferredHole(groupJid)
        if (allowingRequests && pending.size > 0) void drain()
    }

    function persistMediaIfIdle(): void {
        if (trackedJids.length === 0) return
        if (trackedJids.some((groupJid) => !backfillDone.has(groupJid) || !mediaEndings.has(groupJid))) return
        if ([...pending.values()].some((walk) => walk.kind === 'media')) return
        if ([...awaiting.values()].some((walk) => walk.kind === 'media')) return
        const finishedGroups = [...mediaEndings.entries()]
            .filter(([, why]) => !RETRY_MEDIA_LATER.has(why))
            .map(([groupJid]) => groupJid)
        const done = trackedJids.every((groupJid) => {
            const why = mediaEndings.get(groupJid)
            return why !== undefined && !RETRY_MEDIA_LATER.has(why)
        })
        const snapshot = [...finishedGroups]
        mediaPersist = mediaPersist
            .then(async () => {
                await setAppSetting(MEDIA_GAP_BACKFILL_KEY, { done, finishedGroups: snapshot, at: Date.now() })
                if (done) log.info({ groups: snapshot.length }, 'media_gap.complete')
            })
            .catch((err) => {
                log.warn({ err }, 'media_gap.persist_failed')
            })
    }

    return {
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
            pending.clear()
            deferredHoles.clear()
            clearHeadConfirms()
            clearSettleTimer()
            for (const groupJid of [...awaiting.keys()]) clearAwaiting(groupJid)
        },
    }
}
