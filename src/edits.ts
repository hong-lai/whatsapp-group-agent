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
    fillMessageSecretIfMissing,
    getMessageEditTarget,
    markMessageEdited,
} from './db.js'
import { log } from './log.js'

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

const pendingEdits = new Map<string, PendingEdit[]>()

export type EditResult = 'not-edit' | 'applied' | 'pending' | 'failed'

export function encodeMessageSecret(bytes: Uint8Array | number[] | Buffer): string {
    return JSON.stringify(Array.from(bytes))
}

export function extractMessageSecret(message: proto.IMessage | null | undefined): string | null {
    const inner = normalizeMessageContent(message) || message
    const bytes = message?.messageContextInfo?.messageSecret || inner?.messageContextInfo?.messageSecret
    return bytes ? encodeMessageSecret(bytes) : null
}

export function textFromMessage(message: proto.IMessage | null | undefined): string | null {
    if (!message) return null
    const nested = message.protocolMessage?.editedMessage
    if (nested) {
        const fromNested = textFromMessage(nested)
        if (fromNested != null) return fromNested
    }
    const content = normalizeMessageContent(message) || message
    return (
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
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
        queuePending(targetId, { ...meta, text })
        log.warn({ targetMessageId: targetId, groupJid: meta.groupJid }, 'message.edit_target_missing')
        return 'pending'
    }
    log.info(
        { messageId: targetId, groupJid: meta.groupJid, isHistory: meta.isHistory },
        'message.edited'
    )
    return 'applied'
}

function queuePending(targetId: string, edit: PendingEdit): void {
    const current = pendingEdits.get(targetId) ?? []
    current.push(edit)
    pendingEdits.set(targetId, current)
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
    const queued = pendingEdits.get(messageId)
    if (!queued?.length) return
    pendingEdits.delete(messageId)
    const target = await getMessageEditTarget(messageId)
    if (!target) {
        pendingEdits.set(messageId, queued)
        return
    }
    for (const edit of queued) {
        if (edit.text != null) {
            await persistEdit(messageId, edit.text, edit)
            continue
        }
        if (!edit.encrypted) continue
        if (!target.messageSecret) {
            queuePending(messageId, edit)
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
            queuePending(targetId, { ...meta, encrypted: pending })
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
