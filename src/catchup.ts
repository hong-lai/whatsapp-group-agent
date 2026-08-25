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
import { waitHistoryRead } from './rateLimit.js'

function unixSeconds(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000)
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

function isOnDemandSync(syncType: unknown): boolean {
    return (
        syncType === proto.HistorySync.HistorySyncType.ON_DEMAND ||
        syncType === 'ON_DEMAND' ||
        Number(syncType) === proto.HistorySync.HistorySyncType.ON_DEMAND
    )
}

export function asCatchupMessage(value: { key?: WAMessageKey | null } | null | undefined): WAMessage | undefined {
    return value?.key ? (value as WAMessage) : undefined
}

export function createCatchup(sock: WASocket) {
    const windowStart = Math.floor(Date.now() / 1000) - config.catchupWindowSeconds
    const fetching = new Set<string>()
    const pages = new Map<string, number>()

    async function isTrackedGroup(groupJid: string): Promise<boolean> {
        const cached = await getGroupMetadata(groupJid)
        return cached ? matchesGroupPattern(cached.subject) : false
    }

    async function requestFromAnchor(
        groupJid: string,
        key: WAMessageKey,
        timestamp: number,
        reason: string
    ): Promise<void> {
        if (!key.id || timestamp < windowStart) return
        const page = pages.get(groupJid) ?? 0
        if (page >= config.catchupMaxPages || fetching.has(groupJid)) return

        fetching.add(groupJid)
        pages.set(groupJid, page + 1)
        try {
            await waitHistoryRead()
            await sock.fetchMessageHistory(config.catchupPageSize, key, timestamp * 1000)
            log.info(
                {
                    groupJid,
                    messageId: key.id,
                    page: page + 1,
                    reason,
                    windowStart,
                },
                'catchup.history_requested'
            )
        } catch (err) {
            log.warn({ err, groupJid, messageId: key.id, reason }, 'catchup.history_request_failed')
        } finally {
            fetching.delete(groupJid)
        }
    }

    async function considerMessage(m: WAMessage, reason: string): Promise<void> {
        const groupJid = m.key.remoteJid
        if (!groupJid || !isJidGroup(groupJid) || !m.key.id) return
        if (!(await isTrackedGroup(groupJid))) return

        const timestamp = unixSeconds(m.messageTimestamp)
        if (timestamp < windowStart) return

        const previous = await getLatestGroupMessage(groupJid)
        if (previous && previous.messageId === m.key.id) {
            return
        }
        if (previous && previous.timestamp >= timestamp - 2) return

        await requestFromAnchor(groupJid, m.key, timestamp, reason)
    }

    async function considerHistoryBatch(
        messages: WAMessage[],
        syncType: unknown,
        latestBefore: Map<string, number | undefined>
    ): Promise<void> {
        if (!isOnDemandSync(syncType) || messages.length === 0) return

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
            await requestFromAnchor(groupJid, oldest.key, oldestTs, 'on_demand_continue')
        }
    }

    return { windowStart, considerMessage, considerHistoryBatch }
}
