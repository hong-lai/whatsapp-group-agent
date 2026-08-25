import makeWASocket, {
    aesDecryptGCM,
    DisconnectReason,
    downloadMediaMessage,
    getContentType,
    type GroupMetadata,
    hmacSign,
    isJidGroup,
    jidDecode,
    jidNormalizedUser,
    proto,
    useMultiFileAuthState,
    type WAMessage,
    type WASocket,
    type WAProto
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import type { Readable } from 'stream'
import logger from '@whiskeysockets/baileys/lib/Utils/logger.js'
import pino from 'pino'
import { startApi } from './api.js'
import { config, matchesGroupPattern } from './config.js'
import {
    deleteGroupMetadata,
    getGroupMetadata,
    setGroupMetadata,
} from './cache.js'
import {
    getMessageSecret,
    initDb,
    insertMessage,
    markGroupDeleted,
    markMessageEdited,
    markMessagesDeleted,
    removeReaction,
    upsertGroup,
    upsertReaction,
    upsertSender,
} from './db.js'
import { waitHistoryRead, waitMediaDownload } from './rateLimit.js'

const fileTypes: Record<string, string> = {
    imageMessage: 'jpeg',
    videoMessage: 'mp4',
    stickerMessage: 'webp',
    documentMessage: 'pdf',
    audioMessage: 'ogg',
}

function ownJid(sock: WASocket): string | undefined {
    const id = sock.user?.id
    return id ? jidNormalizedUser(id) : undefined
}

async function persistMatchingGroup(metadata: GroupMetadata): Promise<boolean> {
    const name = metadata.subject
    const tracked = matchesGroupPattern(name)
    await upsertGroup(metadata.id, name || metadata.id, tracked)
    if (tracked) {
        await setGroupMetadata(metadata.id, metadata)
        return true
    }
    await deleteGroupMetadata(metadata.id)
    return false
}

async function forgetGroup(jid: string, reason: string): Promise<void> {
    await markGroupDeleted(jid)
    await deleteGroupMetadata(jid)
    console.log('Group forgotten:', jid, reason)
}

async function refreshGroup(sock: WASocket, jid: string): Promise<GroupMetadata | undefined> {
    try {
        const metadata = await sock.groupMetadata(jid)
        if (!metadata) {
            await forgetGroup(jid, 'empty metadata')
            return undefined
        }
        await persistMatchingGroup(metadata)
        return metadata
    } catch (err) {
        await forgetGroup(jid, `metadata fetch failed: ${String(err)}`)
        return undefined
    }
}

const decryptEditedMessage = (
    { encPayload, encIv }: { encPayload?: Uint8Array | null; encIv?: Uint8Array | null },
    { secret, id, sender }: { secret: Uint8Array; id: string; sender: string }
) => {
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
    const decrypted = aesDecryptGCM(encPayload as Uint8Array, decKey, encIv as Uint8Array, new Uint8Array())
    return proto.Message.decode(decrypted)
}

function secondsFromMillis(value: unknown, fallback: number): number {
    const millis = Number(value)
    return Number.isFinite(millis) && millis > 0 ? Math.floor(millis / 1000) : fallback
}

async function resolveGroupMetadata(jid: string, sock: WASocket): Promise<GroupMetadata | undefined> {
    const cached = await getGroupMetadata(jid)
    if (cached) return cached
    return refreshGroup(sock, jid)
}

async function processMessage(m: WAMessage, sock: WASocket, isHistory = false) {
    if (!m.message || !m.key.remoteJid) return

    const jid = m.key.remoteJid
    if (!isJidGroup(jid)) return

    const groupMetadata = await resolveGroupMetadata(jid, sock)
    if (!groupMetadata) return

    const groupName = groupMetadata.subject
    if (!matchesGroupPattern(groupName)) return

    const messageId = m.key.id
    const messageType = getContentType(m.message) || 'unknown'
    const rawSender = m.key.fromMe
        ? sock.user?.id
        : (m.key.participant || m.participant)

    const senderId = rawSender ? jidNormalizedUser(rawSender) : jid
    const senderName = m.pushName || jidDecode(senderId)?.user || ''
    const timestamp = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)

    if (messageType === 'protocolMessage') return

    console.log(`\n--- [${isHistory ? 'HISTORY' : 'LIVE'}] ${groupName} ---`)
    console.log('ID:        ', messageId)
    console.log('Sender ID:    ', senderId)
    console.log('Push Name: ', senderName)
    console.log('Type:      ', messageType)
    console.log('Date:      ', new Date(timestamp * 1000).toLocaleString())

    const reaction = m.message.reactionMessage
    if (reaction) {
        const targetMessageId = reaction.key?.id
        if (!targetMessageId) return

        const emoji = reaction.text?.trim() || ''
        const reactedAt = secondsFromMillis(reaction.senderTimestampMs, timestamp)
        try {
            await upsertGroup(jid, groupName, true)
            await upsertSender(senderId, senderName)
            if (emoji) {
                await upsertReaction({
                    targetMessageId,
                    groupJid: jid,
                    senderJid: senderId,
                    emoji,
                    timestamp: reactedAt,
                    isHistory,
                })
                console.log(`${emoji} Reaction saved for message ${targetMessageId}.`)
            } else {
                await removeReaction(targetMessageId, senderId, reactedAt)
                console.log(`🚫 Reaction removed from message ${targetMessageId}.`)
            }
        } catch (err) {
            console.error(`❌ DB Reaction Error for ${targetMessageId}:`, err)
        }
        return
    }

    const textContent =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        null

    const replyToId = m.message?.extendedTextMessage?.contextInfo?.stanzaId || null
    const quotedMessage =
        m.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
        m.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.caption ||
        null

    let messageSecret: string | null = null
    const secretBytes = m.message.messageContextInfo?.messageSecret
    if (secretBytes) {
        messageSecret = JSON.stringify(Array.from(secretBytes))
    }

    if (textContent) {
        console.log(`💬 Text: ${textContent}`)
    }

    let mediaPath: string | null = null

    if (messageType && fileTypes[messageType]) {
        try {
            await waitMediaDownload()
            const stream = await downloadMediaMessage(
                m,
                'stream',
                {},
                {
                    logger,
                    reuploadRequest: sock.updateMediaMessage,
                }
            )
            const hktDate = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Hong_Kong',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            }).format(timestamp * 1000)

            const safeFolderName = groupName.replace(/[/\\?%*:|"<>]/g, '_')
            const folderPath = `${config.downloadDir}/${safeFolderName}/${hktDate}`

            if (!existsSync(folderPath)) {
                mkdirSync(folderPath, { recursive: true })
            }

            const fileName = `${folderPath}/${timestamp}_${messageId}.${fileTypes[messageType]}`
            await pipeline(stream as Readable, createWriteStream(fileName))
            mediaPath = fileName
            console.log(`📁 Media saved to: ${fileName}`)
        } catch (err) {
            console.error('❌ Error downloading media:', err)
        }
    }

    if (messageId) {
        try {
            await upsertGroup(jid, groupName, true)
            await upsertSender(senderId, senderName)
            await insertMessage({
                messageId,
                groupJid: jid,
                senderJid: senderId,
                messageSecret,
                messageType,
                textContent,
                mediaPath,
                replyToId,
                quotedMessage,
                timestamp,
                isHistory,
            })
            console.log(`💾 Message ${messageId} saved to DB.`)
        } catch (err) {
            console.error(`❌ DB Insert Error for ${messageId}:`, err)
        }
    }
}

function clearAuthContents(dir: string): void {
    mkdirSync(dir, { recursive: true })
    for (const name of readdirSync(dir)) {
        rmSync(join(dir, name), { recursive: true, force: true })
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir)

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        cachedGroupMetadata: async (jid) => getGroupMetadata(jid),
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
    })

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
            console.log('Scan this WhatsApp QR in the phone app:')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
            const loggedOut = statusCode === DisconnectReason.loggedOut
            console.log('Connection closed, status:', statusCode, 'loggedOut:', loggedOut)
            if (loggedOut) {
                console.log('WhatsApp session is logged out. Clearing auth files so a new QR can be scanned.')
                clearAuthContents(config.authDir)
            }
            connectToWhatsApp()
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp')

            const response = await sock.groupFetchAllParticipating()
            let cached = 0
            for (const key in response) {
                const metadata = response[key]
                if (!metadata) continue
                if (await persistMatchingGroup(metadata)) cached += 1
            }
            console.log(`📦 Pre-cached ${cached} matching groups`)
        }
    })

    sock.ev.on('messaging-history.set', async ({ messages, contacts, syncType }) => {
        console.log(`📥 Processing history sync (Type: ${syncType}, Items: ${messages?.length || 0})`)

        for (const c of contacts) {
            console.log(c)
        }
        for (const m of messages) {
            await waitHistoryRead()
            await processMessage(m, sock, true)
        }
    })

    const MessageEditEncType = proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT

    sock.ev.on('messages.upsert', async (event) => {
        if (event.type == 'notify') {
            console.log('Total messages:', event.messages.length)
            for (const m of event.messages) {
                const secEncMsg = m.message?.secretEncryptedMessage
                if (secEncMsg?.secretEncType === MessageEditEncType) {
                    const targetMsgId = secEncMsg.targetMessageKey?.id
                    if (!targetMsgId) continue
                    const storedSecret = await getMessageSecret(targetMsgId)
                    if (storedSecret) {
                        const msgSec = new Uint8Array(JSON.parse(storedSecret))
                        try {
                            const decryptedMessage: WAProto.IMessage = decryptEditedMessage(secEncMsg, {
                                secret: msgSec,
                                id: targetMsgId,
                                sender: m.key.participant || m.participant || m.key.remoteJid || '',
                            })
                            console.log(decryptedMessage)
                            const editedMessage =
                                decryptedMessage.protocolMessage?.editedMessage?.conversation ??
                                decryptedMessage.protocolMessage?.editedMessage?.imageMessage?.caption ??
                                ''
                            await markMessageEdited(targetMsgId, editedMessage)
                        } catch {
                            console.log('❌ Failed to decrypt the edited message.')
                        }
                    }
                } else {
                    await processMessage(m, sock, false)
                }
            }
        }
    })

    sock.ev.on('messages.update', async (updates) => {
        const deletedIds: string[] = []
        for (const u of updates) {
            if (u.update.messageStubType === 1 && u.key.id) {
                deletedIds.push(u.key.id)
            }
        }
        if (deletedIds.length > 0) {
            await markMessagesDeleted(deletedIds)
        }
    })

    sock.ev.on('messages.delete', async (e) => {
        if ('keys' in e) {
            const ids = e.keys.map((k) => k.id).filter((id): id is string => Boolean(id))
            await markMessagesDeleted(ids)
            return
        }
        console.log('messages.delete all for', e.jid)
    })

    sock.ev.on('groups.upsert', async (groups) => {
        for (const group of groups) {
            const tracked = await persistMatchingGroup(group)
            if (tracked) {
                console.log('Tracking new group', group.id, group.subject)
            }
        }
    })

    sock.ev.on('groups.update', async (events) => {
        for (const event of events) {
            if (!event?.id) continue
            const previous = await getGroupMetadata(event.id)
            if (event.subject && previous && event.subject !== previous.subject) {
                console.log('Group renamed:', event.id, previous.subject, '->', event.subject)
            }
            await refreshGroup(sock, event.id)
        }
    })

    sock.ev.on('chats.delete', async (jids) => {
        for (const jid of jids) {
            if (isJidGroup(jid)) {
                await forgetGroup(jid, 'chats.delete')
            }
        }
    })

    sock.ev.on('group-participants.update', async (event) => {
        const me = ownJid(sock)
        const removedSelf =
            event.action === 'remove' &&
            Boolean(me) &&
            event.participants.some((p) => jidNormalizedUser(p.id) === me)

        if (removedSelf) {
            await forgetGroup(event.id, 'removed from group')
            return
        }

        const metadata = await refreshGroup(sock, event.id)
        if (metadata) {
            console.log('Updated group participants for', event.id, 'with name', metadata.subject)
        }
    })

    sock.ev.on('creds.update', saveCreds)
}

;(async () => {
    await initDb()
    startApi()
    await connectToWhatsApp()
})()
