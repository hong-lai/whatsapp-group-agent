import {
    isHostedLidUser,
    isHostedPnUser,
    isLidUser,
    isPnUser,
    jidNormalizedUser,
    type Contact,
    type GroupMetadata,
    type LIDMapping,
    type WASocket,
} from '@whiskeysockets/baileys'
import {
    resolveLinkedJids,
    setLidPnMapping,
    setSenderDisplayNames,
    getSenderDisplayNames,
} from './cache.js'
import { upsertSenders } from '../../../packages/shared/src/db/index.js'

type NamedContact = Pick<Contact, 'id' | 'lid' | 'phoneNumber' | 'name' | 'notify' | 'verifiedName'>

export function isPersonJid(jid: string | undefined | null): jid is string {
    if (!jid) return false
    return Boolean(isPnUser(jid) || isLidUser(jid) || isHostedPnUser(jid) || isHostedLidUser(jid))
}

export function usableDisplayName(value: string | undefined | null): string {
    const name = value?.trim() ?? ''
    if (!name) return ''
    if (name.includes('@')) return ''
    if (/^\d{8,}$/.test(name)) return ''
    return name
}

function contactDisplayName(contact: Partial<NamedContact>): string {
    return (
        usableDisplayName(contact.name) ||
        usableDisplayName(contact.notify) ||
        usableDisplayName(contact.verifiedName)
    )
}

export async function linkedJids(...jids: Array<string | undefined | null>): Promise<string[]> {
    const keys: string[] = []
    const seen = new Set<string>()
    for (const jid of jids) {
        if (!isPersonJid(jid)) continue
        const key = jidNormalizedUser(jid)
        if (seen.has(key)) continue
        seen.add(key)
        keys.push(key)
    }
    return resolveLinkedJids(keys)
}

async function noteLidMapping(pn: string, lid: string): Promise<[string, string]> {
    const pnJid = jidNormalizedUser(pn)
    const lidJid = jidNormalizedUser(lid)
    await setLidPnMapping(lidJid, pnJid)
    return [pnJid, lidJid]
}

export async function cachedSenderName(...jids: Array<string | undefined | null>): Promise<string> {
    const linked = await linkedJids(...jids)
    const names = await getSenderDisplayNames(linked)
    for (const jid of linked) {
        const name = names.get(jid)
        if (name) return name
    }
    return ''
}

export function nameFromGroup(
    metadata: GroupMetadata,
    ...jids: Array<string | undefined | null>
): string {
    const wanted = new Set(
        jids.filter((jid): jid is string => Boolean(jid)).map((jid) => jidNormalizedUser(jid))
    )
    if (wanted.size === 0) return ''
    for (const participant of metadata.participants || []) {
        const ids = [participant.id, participant.lid, participant.phoneNumber]
            .filter((jid): jid is string => Boolean(jid))
            .map((jid) => jidNormalizedUser(jid))
        if (!ids.some((id) => wanted.has(id))) continue
        const name = contactDisplayName(participant)
        if (name) return name
    }
    return ''
}

export async function rememberContacts(contacts: Array<Partial<NamedContact>> | undefined): Promise<void> {
    if (!contacts?.length) return
    const rows: Array<{ jid: string; displayName: string }> = []
    const seen = new Set<string>()
    for (const contact of contacts) {
        const name = contactDisplayName(contact)
        if (!name) continue
        const pn =
            isPersonJid(contact.phoneNumber)
                ? contact.phoneNumber
                : contact.id?.includes('@s.whatsapp.net')
                  ? contact.id
                  : undefined
        const lid =
            isPersonJid(contact.lid)
                ? contact.lid
                : contact.id?.includes('@lid')
                  ? contact.id
                  : undefined
        if (pn && lid) await noteLidMapping(pn, lid)
        const ids = (await linkedJids(contact.id, contact.lid, contact.phoneNumber)).filter(
            isPersonJid
        )
        if (ids.length === 0) continue
        const nameEntries: Array<{ jid: string; name: string }> = []
        for (const jid of ids) {
            if (seen.has(jid)) continue
            seen.add(jid)
            nameEntries.push({ jid, name })
            rows.push({ jid, displayName: name })
        }
        await setSenderDisplayNames(nameEntries)
    }
    await upsertSenders(rows)
}

export async function rememberLidMappings(mappings: LIDMapping[] | undefined): Promise<void> {
    if (!mappings?.length) return
    const rows: Array<{ jid: string; displayName: string }> = []
    const seen = new Set<string>()
    for (const mapping of mappings) {
        if (!mapping.pn || !mapping.lid) continue
        const [pnJid, lidJid] = await noteLidMapping(mapping.pn, mapping.lid)
        if (!isPersonJid(pnJid) || !isPersonJid(lidJid)) continue
        const name = await cachedSenderName(pnJid, lidJid)
        if (!name) continue
        const nameEntries: Array<{ jid: string; name: string }> = []
        for (const jid of [pnJid, lidJid]) {
            if (seen.has(jid)) continue
            seen.add(jid)
            nameEntries.push({ jid, name })
            rows.push({ jid, displayName: name })
        }
        await setSenderDisplayNames(nameEntries)
    }
    await upsertSenders(rows)
}

export function ownUser(sock: WASocket): { id?: string; lid?: string; name?: string } | undefined {
    return sock.user as { id?: string; lid?: string; name?: string } | undefined
}

export async function rememberMessageSender(
    senderId: string,
    altSender: string | undefined,
    senderName: string
): Promise<void> {
    const jids = (await linkedJids(senderId, altSender)).filter(isPersonJid)
    if (jids.length === 0) return
    await upsertSenders(jids.map((jid) => ({ jid, displayName: senderName })))
}
