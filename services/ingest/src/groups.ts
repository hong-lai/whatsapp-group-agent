import { jidNormalizedUser, type GroupMetadata, type WASocket } from '@whiskeysockets/baileys'
import { log } from '../../../packages/shared/src/log.js'
import {
    addSkippedGroup,
    deleteGroupMetadata,
    deleteParticipatingMeta,
    getGroupMetadata,
    getParticipatingMeta,
    isSkippedGroup,
    setGroupMetadata,
    setParticipatingMeta,
    removeSkippedGroup,
} from './cache.js'
import { config, matchesGroupPattern } from './config.js'
import { rememberContacts } from './contacts.js'
import { markGroupDeleted, upsertGroup } from '../../../packages/shared/src/db/index.js'

function isRateOverlimit(err: unknown): boolean {
    return String(err).includes('rate-overlimit')
}

export function mergeDefined<T extends object>(base: T, patch: Partial<T>): T {
    const next = { ...base }
    for (const key of Object.keys(patch) as (keyof T)[]) {
        const value = patch[key]
        if (value !== undefined) next[key] = value as T[keyof T]
    }
    return next
}

export function ownJid(sock: WASocket): string | undefined {
    const id = sock.user?.id
    return id ? jidNormalizedUser(id) : undefined
}

export function metadataFromHistoryChat(chat: {
    id?: string | null
    name?: string | null
    displayName?: string | null
}): GroupMetadata | undefined {
    const id = chat.id
    if (!id) return undefined
    const subject = (chat.name || chat.displayName || '').trim()
    if (!subject) return undefined
    return {
        id,
        subject,
        owner: undefined,
        participants: [],
    }
}

export async function persistMatchingGroup(metadata: GroupMetadata): Promise<boolean> {
    await setParticipatingMeta(metadata.id, metadata)
    const name = metadata.subject
    const tracked = matchesGroupPattern(name)
    await upsertGroup(metadata.id, name || metadata.id, tracked)
    await rememberContacts(metadata.participants)
    if (tracked) {
        await removeSkippedGroup(metadata.id)
        await setGroupMetadata(metadata.id, metadata)
        return true
    }
    await addSkippedGroup(metadata.id)
    await deleteGroupMetadata(metadata.id)
    return false
}

export async function forgetGroup(jid: string, reason: string): Promise<void> {
    const rateLimited = reason.includes('rate-overlimit')
    if (rateLimited) {
        await addSkippedGroup(jid)
        log.warn({ groupJid: jid, reason }, 'group.metadata_rate_limited')
        return
    }
    await deleteParticipatingMeta(jid)
    await markGroupDeleted(jid)
    await deleteGroupMetadata(jid)
    log.info({ groupJid: jid, reason }, 'group.forgotten')
}

export async function refreshGroup(
    sock: WASocket,
    jid: string,
    source: string
): Promise<GroupMetadata | undefined> {
    try {
        const metadata = await sock.groupMetadata(jid)
        if (!metadata) {
            await forgetGroup(jid, 'empty metadata')
            return undefined
        }
        await persistMatchingGroup(metadata)
        return metadata
    } catch (err) {
        if (isRateOverlimit(err)) {
            await addSkippedGroup(jid)
            log.warn({ err, groupJid: jid, source }, 'group.metadata_rate_limited')
            return undefined
        }
        await forgetGroup(jid, `metadata fetch failed: ${String(err)}`)
        return undefined
    }
}
