import { Redis } from 'ioredis'
import type { GroupMetadata } from '@whiskeysockets/baileys'
import { config } from './config.js'

export const redis = new Redis(config.redisUrl)

function groupKey(jid: string): string {
    return `group:${jid}`
}

export async function getGroupMetadata(jid: string): Promise<GroupMetadata | undefined> {
    const raw = await redis.get(groupKey(jid))
    if (!raw) return undefined
    try {
        return JSON.parse(raw) as GroupMetadata
    } catch {
        return undefined
    }
}

export async function setGroupMetadata(jid: string, metadata: GroupMetadata): Promise<void> {
    await redis.set(groupKey(jid), JSON.stringify(metadata))
}

export async function deleteGroupMetadata(jid: string): Promise<void> {
    await redis.del(groupKey(jid))
}
