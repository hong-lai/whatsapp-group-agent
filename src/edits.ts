import {
    aesDecryptGCM,
    hmacSign,
    jidNormalizedUser,
    normalizeMessageContent,
    proto,
    type WAMessage,
    type WAMessageKey,
} from '@whiskeysockets/baileys'
import {
    deletePendingEdits,
    getPendingEdits,
    setPendingEdits,
    type CachedPendingEdit,
} from './cache.js'
import {
    fillMessageSecretIfMissing,
    getMessageEditTarget,
    markMessageEdited,
} from './db.js'
import { log } from './log.js'
import { enqueueMessageEvent } from './queue/index.js'

const MessageEditEncType = proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT
const ProtocolEditType = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT

type PendingEdit = {
    groupJid: string | null
    isHistory: boolean
    text?: string
    encrypted?: {
        encPayload: Uint8Array
        encIv: Uint8Array
        senders: string[]
    }
}

export type EditResult = 'not-edit' | 'applied' | 'pending' | 'failed'

function encodePendingEdit(edit: PendingEdit): CachedPendingEdit {
    const cached: CachedPendingEdit = {
        groupJid: edit.groupJid,
        isHistory: edit.isHistory,
    }
    if (edit.text != null) cached.text = edit.text
    if (edit.encrypted) {
        cached.encrypted = {
            encPayload: Array.from(edit.encrypted.encPayload),
            encIv: Array.from(edit.encrypted.encIv),
            senders: edit.encrypted.senders,
        }
    }
    return cached
}

function decodePendingEdit(edit: CachedPendingEdit): PendingEdit {
    const pending: PendingEdit = {
        groupJid: edit.groupJid,
        isHistory: edit.isHistory,
    }
    if (edit.text != null) pending.text = edit.text
    if (edit.encrypted) {
        pending.encrypted = {
            encPayload: Uint8Array.from(edit.encrypted.encPayload),
            encIv: Uint8Array.from(edit.encrypted.encIv),
            senders: edit.encrypted.senders,
        }
    }
    return pending
}

export function encodeMessageSecret(bytes: Uint8Array | number[] | Buffer): string {
    return JSON.stringify(Array.from(bytes))
}

export function extractMessageSecret(message: proto.IMessage | null | undefined): string | null {
    const inner = normalizeMessageContent(message) || message
    const bytes = message?.messageContextInfo?.messageSecret || inner?.messageContextInfo?.messageSecret
    return bytes ? encodeMessageSecret(bytes) : null
}

function vcardField(vcard: string, key: string): string | null {
    const match = vcard.match(new RegExp(`^${key}(?:;[^:]*)?:\\s*(.+)$`, 'im'))
    return match?.[1]?.replace(/\\n/g, '\n').trim() || null
}

function textFromContact(contact: proto.Message.IContactMessage | null | undefined): string | null {
    if (!contact) return null
    const vcard = contact.vcard || ''
    const name = contact.displayName?.trim() || vcardField(vcard, 'FN')
    const phone = vcardField(vcard, 'TEL')
    const lines = [name, phone].filter(Boolean)
    return lines.length ? lines.join('\n') : null
}

function textFromLocation(
    location: proto.Message.ILocationMessage | proto.Message.ILiveLocationMessage | null | undefined
): string | null {
    if (!location) return null
    const lat = location.degreesLatitude
    const lng = location.degreesLongitude
    const live = 'caption' in location ? location.caption?.trim() : undefined
    const named = 'name' in location ? location.name?.trim() : undefined
    const address = 'address' in location ? location.address?.trim() : undefined
    const comment = 'comment' in location ? location.comment?.trim() : undefined
    const givenUrl = 'url' in location ? location.url?.trim() : undefined
    const lines = [named, address, live || comment].filter(Boolean) as string[]
    if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
        lines.push(`https://maps.google.com/?q=${lat},${lng}`)
    } else if (givenUrl) {
        lines.push(givenUrl)
    }
    return lines.length ? lines.join('\n') : null
}

export function textFromMessage(message: proto.IMessage | null | undefined): string | null {
    if (!message) return null
    const nested = message.protocolMessage?.editedMessage
    if (nested) {
        const fromNested = textFromMessage(nested)
        if (fromNested != null) return fromNested
    }
    const content = normalizeMessageContent(message) || message
    const contacts = (content.contactsArrayMessage?.contacts || [])
        .map((contact) => textFromContact(contact))
        .filter((text): text is string => Boolean(text))
    return (
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        textFromContact(content.contactMessage) ||
        (contacts.length ? contacts.join('\n\n') : content.contactsArrayMessage?.displayName?.trim()) ||
        textFromLocation(content.locationMessage) ||
        textFromLocation(content.liveLocationMessage) ||
        null
    )
}

export function isEditedWrapper(message: proto.IMessage | null | undefined): boolean {
    return Boolean(message?.editedMessage)
}

export function isEditEnvelope(message: proto.IMessage | null | undefined): boolean {
    if (!message) return false
    if (message.secretEncryptedMessage?.secretEncType === MessageEditEncType) return true
    const protocol = message.protocolMessage
    return Boolean(protocol && (protocol.type === ProtocolEditType || protocol.editedMessage))
}

function copyBytes(value: Uint8Array | Buffer | number[] | null | undefined): Uint8Array | undefined {
    if (!value) return undefined
    return Uint8Array.from(value)
}

function uniqueSenders(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>()
    const senders: string[] = []
    for (const value of values) {
        if (!value) continue
        for (const candidate of [value, jidNormalizedUser(value)]) {
            if (!candidate || seen.has(candidate)) continue
            seen.add(candidate)
            senders.push(candidate)
        }
    }
    return senders
}

function senderCandidates(message: WAMessage, storedSender?: string | null): string[] {
    return uniqueSenders([
        message.key.participant,
        message.participant,
        message.key.participantAlt,
        storedSender,
        message.key.remoteJid,
    ])
}

function decryptEditedMessage(
    { encPayload, encIv }: { encPayload: Uint8Array; encIv: Uint8Array },
    { secret, id, sender }: { secret: Uint8Array; id: string; sender: string }
): proto.IMessage {
    const toBinary = (txt: string) => Buffer.from(txt)
    const senderBuf = toBinary(sender)
    const sign = Buffer.concat([
        toBinary(id),
        senderBuf,
        senderBuf,
        toBinary('Message Edit'),
        new Uint8Array([1]),
    ])
    const key = hmacSign(secret, new Uint8Array(32))
    const decKey = hmacSign(sign, key)
    return proto.Message.decode(aesDecryptGCM(encPayload, decKey, encIv, new Uint8Array()))
}

async function persistEdit(
    targetId: string,
    text: string,
    meta: { groupJid: string | null; isHistory: boolean }
): Promise<EditResult> {
    const updated = await markMessageEdited(targetId, text)
    if (!updated) {
        await queuePending(targetId, { ...meta, text })
        log.warn({ targetMessageId: targetId, groupJid: meta.groupJid }, 'message.edit_target_missing')
        return 'pending'
    }
    log.info(
        { messageId: targetId, groupJid: meta.groupJid, isHistory: meta.isHistory },
        'message.edited'
    )
    void enqueueMessageEvent({
        event: 'message.edited',
        messageId: targetId,
        groupJid: meta.groupJid,
        messageType: null,
        mediaPath: null,
        isHistory: meta.isHistory,
    })
    return 'applied'
}

async function queuePending(targetId: string, edit: PendingEdit): Promise<void> {
    const current = await getPendingEdits(targetId)
    current.push(encodePendingEdit(edit))
    await setPendingEdits(targetId, current)
}

async function decryptAndApply(
    targetId: string,
    encrypted: NonNullable<PendingEdit['encrypted']>,
    secret: string,
    meta: { groupJid: string | null; isHistory: boolean }
): Promise<EditResult> {
    const secretBytes = new Uint8Array(JSON.parse(secret) as number[])
    for (const sender of encrypted.senders) {
        try {
            const decrypted = decryptEditedMessage(encrypted, {
                secret: secretBytes,
                id: targetId,
                sender,
            })
            const text = textFromMessage(decrypted)
            if (text == null) continue
            return persistEdit(targetId, text, meta)
        } catch {
            continue
        }
    }
    log.warn({ targetMessageId: targetId, groupJid: meta.groupJid }, 'message.edit_decrypt_failed')
    return 'failed'
}

export async function flushPendingEdits(messageId: string): Promise<void> {
    const cached = await getPendingEdits(messageId)
    if (!cached.length) return
    await deletePendingEdits(messageId)
    const queued = cached.map(decodePendingEdit)
    const target = await getMessageEditTarget(messageId)
    if (!target) {
        await setPendingEdits(messageId, cached)
        return
    }
    for (const edit of queued) {
        if (edit.text != null) {
            await persistEdit(messageId, edit.text, edit)
            continue
        }
        if (!edit.encrypted) continue
        if (!target.messageSecret) {
            await queuePending(messageId, edit)
            continue
        }
        await decryptAndApply(messageId, edit.encrypted, target.messageSecret, edit)
    }
}

export async function applyPlaintextEdit(
    targetId: string,
    text: string,
    meta: { groupJid: string | null; isHistory: boolean }
): Promise<EditResult> {
    return persistEdit(targetId, text, meta)
}

export async function applyIncomingEdit(message: WAMessage, isHistory: boolean): Promise<EditResult> {
    const content = message.message
    if (!content || !isEditEnvelope(content)) return 'not-edit'

    const groupJid = message.key.remoteJid ?? null
    const meta = { groupJid, isHistory }
    const encrypted = content.secretEncryptedMessage
    if (encrypted?.secretEncType === MessageEditEncType) {
        const targetId = encrypted.targetMessageKey?.id
        const encPayload = copyBytes(encrypted.encPayload)
        const encIv = copyBytes(encrypted.encIv)
        if (!targetId || !encPayload || !encIv) return 'failed'
        const target = await getMessageEditTarget(targetId)
        const senders = senderCandidates(message, target?.senderJid)
        const pending = { encPayload, encIv, senders }
        if (!target?.messageSecret) {
            await queuePending(targetId, { ...meta, encrypted: pending })
            log.warn({ targetMessageId: targetId, groupJid }, 'message.edit_secret_missing')
            return 'pending'
        }
        return decryptAndApply(targetId, pending, target.messageSecret, meta)
    }

    const protocol = content.protocolMessage
    const targetId = protocol?.key?.id
    const text = textFromMessage(protocol?.editedMessage)
    if (!targetId || text == null) return 'failed'
    return persistEdit(targetId, text, meta)
}

export async function applyEditUpdate(
    key: WAMessageKey,
    updateMessage: proto.IMessage | null | undefined,
    isHistory = false
): Promise<EditResult> {
    if (!key.id || (!isEditedWrapper(updateMessage) && !isEditEnvelope(updateMessage))) {
        return 'not-edit'
    }
    const targetId = updateMessage?.protocolMessage?.key?.id || key.id
    const text = textFromMessage(updateMessage)
    if (!targetId || text == null) return 'failed'
    return persistEdit(targetId, text, { groupJid: key.remoteJid ?? null, isHistory })
}

export async function rememberMessageSecret(
    messageId: string,
    messageSecret: string | null
): Promise<void> {
    if (!messageSecret) return
    await fillMessageSecretIfMissing(messageId, messageSecret)
    await flushPendingEdits(messageId)
}
