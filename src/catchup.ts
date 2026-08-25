import {
    isJidGroup,
    proto,
    type WAMessage,
    type WAMessageKey,
    type WASocket,
} from '@whiskeysockets/baileys'
import { getGroupMetadata } from './cache.js'
import { config, matchesGroupPattern } from './config.js'
import { getLatestGroupMessage } from './db.js'
import { log } from './log.js'
import { settleDelayMs, waitHistoryRequest } from './rateLimit.js'

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
    const pages = new Map<string, number>()
    const jobs = new Map<string, CatchupJob>()
    let allowingRequests = false
    let draining = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    async function isTrackedGroup(groupJid: string): Promise<boolean> {
        const cached = await getGroupMetadata(groupJid)
        return cached ? matchesGroupPattern(cached.subject) : false
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
            if (stopped) return
            allowingRequests = true
            log.info({ pending: jobs.size, reason }, 'catchup.ready')
            void drain()
        }, waitMs)
    }

    async function requestFromAnchor(job: CatchupJob): Promise<'done' | 'retry'> {
        const { groupJid, key, timestamp, reason } = job
        if (!key.id || timestamp < windowStart) return 'done'
        const page = pages.get(groupJid) ?? 0
        if (page >= config.catchupMaxPages) return 'done'

        try {
            const latest = await getLatestGroupMessage(groupJid)
            if (latest && latest.timestamp >= timestamp - 2) return 'done'

            const waitedMs = await waitHistoryRequest()
            if (stopped) return 'done'
            if (!allowingRequests) return 'retry'

            await sock.fetchMessageHistory(config.catchupPageSize, key, timestamp * 1000)
            pages.set(groupJid, page + 1)
            log.info(
                {
                    groupJid,
                    messageId: key.id,
                    page: page + 1,
                    reason,
                    waitedMs,
                    windowStart,
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
        if (stopped || !job.key.id || job.timestamp < windowStart) return
        const page = pages.get(job.groupJid) ?? 0
        if (page >= config.catchupMaxPages) return
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
        if (stopped || !isMessageHistorySync(syncType) || messages.length === 0) return

        const byGroup = new Map<string, WAMessage[]>()
        for (const message of messages) {
            const groupJid = message.key.remoteJid
            if (!groupJid || !isJidGroup(groupJid)) continue
            const list = byGroup.get(groupJid) ?? []
            list.push(message)
            byGroup.set(groupJid, list)
        }

        for (const [groupJid, list] of byGroup) {
            if (!(await isTrackedGroup(groupJid))) continue
            list.sort(
                (left, right) => unixSeconds(left.messageTimestamp) - unixSeconds(right.messageTimestamp)
            )
            const oldest = list[0]
            if (!oldest?.key.id) continue
            const oldestTs = unixSeconds(oldest.messageTimestamp)
            if (oldestTs < windowStart) continue
            const previousTs = latestBefore.get(groupJid)
            if (previousTs !== undefined && previousTs >= oldestTs) continue
            enqueue({
                groupJid,
                key: oldest.key,
                timestamp: oldestTs,
                reason: historySyncNumber(syncType) === proto.HistorySync.HistorySyncType.ON_DEMAND
                    ? 'on_demand_continue'
                    : 'history.gap',
            })
        }
    }

    return {
        windowStart,
        noteConnected() {
            scheduleSettle('connected')
        },
        noteHistoryChunk() {
            scheduleSettle('history.chunk')
        },
        noteHistoryStatus(syncType: unknown, status?: string) {
            if (!shouldSettleOnSyncStatus(syncType)) return
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
