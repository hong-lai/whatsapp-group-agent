import { Redis } from 'ioredis'
import type { GroupMetadata } from '@whiskeysockets/baileys'
import { config } from './config.js'

export const redis = new Redis(config.redisUrl)

const PARTICIPATING_HASH = 'group:participating'
const SKIPPED_SET = 'group:skipped'
const SENDER_NAMES_HASH = 'sender:names'
const FILENAME_FORMAT_KEY = 'settings:filename-format'

function groupKey(jid: string): string {
    return `group:${jid}`
}

function lidToPnKey(lidJid: string): string {
    return `lid:pn:${lidJid}`
}

function pnToLidKey(pnJid: string): string {
    return `pn:lid:${pnJid}`
}

function pendingEditsKey(messageId: string): string {
    return `edit:pending:${messageId}`
}

async function getJson<T>(key: string): Promise<T | undefined> {
    const raw = await redis.get(key)
    if (!raw) return undefined
    try {
        return JSON.parse(raw) as T
    } catch {
        return undefined
    }
}

async function setJson(key: string, value: unknown): Promise<void> {
    await redis.set(key, JSON.stringify(value))
}

export async function getGroupMetadata(jid: string): Promise<GroupMetadata | undefined> {
    return getJson<GroupMetadata>(groupKey(jid))
}

export async function setGroupMetadata(jid: string, metadata: GroupMetadata): Promise<void> {
    await setJson(groupKey(jid), metadata)
}

export async function deleteGroupMetadata(jid: string): Promise<void> {
    await redis.del(groupKey(jid))
}

export async function getParticipatingMeta(jid: string): Promise<GroupMetadata | undefined> {
    const raw = await redis.hget(PARTICIPATING_HASH, jid)
    if (!raw) return undefined
    try {
        return JSON.parse(raw) as GroupMetadata
    } catch {
        return undefined
    }
}

export async function setParticipatingMeta(jid: string, metadata: GroupMetadata): Promise<void> {
    await redis.hset(PARTICIPATING_HASH, jid, JSON.stringify(metadata))
}

export async function deleteParticipatingMeta(jid: string): Promise<void> {
    await redis.hdel(PARTICIPATING_HASH, jid)
}

export async function clearParticipatingMeta(): Promise<void> {
    await redis.del(PARTICIPATING_HASH)
}

export async function listParticipatingMeta(): Promise<GroupMetadata[]> {
    const all = await redis.hgetall(PARTICIPATING_HASH)
    const result: GroupMetadata[] = []
    for (const raw of Object.values(all)) {
        try {
            result.push(JSON.parse(raw) as GroupMetadata)
        } catch {
            // skip corrupt entries
        }
    }
    return result
}

export async function isSkippedGroup(jid: string): Promise<boolean> {
    return (await redis.sismember(SKIPPED_SET, jid)) === 1
}

export async function addSkippedGroup(jid: string): Promise<void> {
    await redis.sadd(SKIPPED_SET, jid)
}

export async function removeSkippedGroup(jid: string): Promise<void> {
    await redis.srem(SKIPPED_SET, jid)
}

export async function clearSkippedGroups(): Promise<void> {
    await redis.del(SKIPPED_SET)
}

export async function getSenderDisplayName(jid: string): Promise<string | undefined> {
    const name = await redis.hget(SENDER_NAMES_HASH, jid)
    return name || undefined
}

export async function setSenderDisplayName(jid: string, name: string): Promise<void> {
    await redis.hset(SENDER_NAMES_HASH, jid, name)
}

export async function setSenderDisplayNames(
    entries: Array<{ jid: string; name: string }>
): Promise<void> {
    if (entries.length === 0) return
    const args: string[] = []
    for (const entry of entries) {
        args.push(entry.jid, entry.name)
    }
    await redis.hset(SENDER_NAMES_HASH, ...args)
}

export async function getLidToPn(lidJid: string): Promise<string | undefined> {
    const value = await redis.get(lidToPnKey(lidJid))
    return value || undefined
}

export async function getPnToLid(pnJid: string): Promise<string | undefined> {
    const value = await redis.get(pnToLidKey(pnJid))
    return value || undefined
}

export async function setLidPnMapping(lidJid: string, pnJid: string): Promise<void> {
    const pipeline = redis.pipeline()
    pipeline.set(lidToPnKey(lidJid), pnJid)
    pipeline.set(pnToLidKey(pnJid), lidJid)
    await pipeline.exec()
}

export async function resolveLinkedJids(jids: string[]): Promise<string[]> {
    if (jids.length === 0) return []
    const pipeline = redis.pipeline()
    for (const jid of jids) {
        pipeline.get(lidToPnKey(jid))
        pipeline.get(pnToLidKey(jid))
    }
    const results = await pipeline.exec()
    const out: string[] = []
    const seen = new Set<string>()
    const push = (value: string | null | undefined) => {
        if (!value || seen.has(value)) return
        seen.add(value)
        out.push(value)
    }
    for (const jid of jids) push(jid)
    if (!results) return out
    for (const [err, value] of results) {
        if (err || typeof value !== 'string') continue
        push(value)
    }
    return out
}

export async function getSenderDisplayNames(jids: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    if (jids.length === 0) return names
    const values = await redis.hmget(SENDER_NAMES_HASH, ...jids)
    for (let i = 0; i < jids.length; i++) {
        const jid = jids[i]
        const name = values[i]
        if (jid && name) names.set(jid, name)
    }
    return names
}

export type CachedPendingEdit = {
    groupJid: string | null
    isHistory: boolean
    text?: string
    encrypted?: {
        encPayload: number[]
        encIv: number[]
        senders: string[]
    }
}

export async function getPendingEdits(messageId: string): Promise<CachedPendingEdit[]> {
    const queued = await getJson<CachedPendingEdit[]>(pendingEditsKey(messageId))
    return queued ?? []
}

export async function setPendingEdits(
    messageId: string,
    edits: CachedPendingEdit[]
): Promise<void> {
    if (edits.length === 0) {
        await redis.del(pendingEditsKey(messageId))
        return
    }
    await setJson(pendingEditsKey(messageId), edits)
}

export async function deletePendingEdits(messageId: string): Promise<void> {
    await redis.del(pendingEditsKey(messageId))
}

export async function getFilenameFormatCache<T>(): Promise<T | undefined> {
    return getJson<T>(FILENAME_FORMAT_KEY)
}

export async function setFilenameFormatCache(value: unknown): Promise<void> {
    await setJson(FILENAME_FORMAT_KEY, value)
}
