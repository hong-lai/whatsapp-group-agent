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
import { log } from './log.js'
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
    log.info({ groupJid: jid, reason }, 'group.forgotten')
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

async function processMessage(m: WAMessage, sock: WASocket, isHistory = false): Promise<'ignored' | 'saved' | 'reaction' | 'error'> {
    if (!m.message || !m.key.remoteJid) return 'ignored'

    const jid = m.key.remoteJid
    if (!isJidGroup(jid)) return 'ignored'

    const groupMetadata = await resolveGroupMetadata(jid, sock)
    if (!groupMetadata) return 'ignored'

    const groupName = groupMetadata.subject
    if (!matchesGroupPattern(groupName)) return 'ignored'

    const messageId = m.key.id
    const messageType = getContentType(m.message) || 'unknown'
    const rawSender = m.key.fromMe
        ? sock.user?.id
        : (m.key.participant || m.participant)

    const senderId = rawSender ? jidNormalizedUser(rawSender) : jid
    const senderName = m.pushName || jidDecode(senderId)?.user || ''
    const timestamp = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)
    const ingestLog = isHistory ? log.debug.bind(log) : log.info.bind(log)

    if (messageType === 'protocolMessage') return 'ignored'

    const reaction = m.message.reactionMessage
    if (reaction) {
        const targetMessageId = reaction.key?.id
        if (!targetMessageId) return 'ignored'

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
                ingestLog(
                    {
                        messageId,
                        targetMessageId,
                        groupJid: jid,
                        groupName,
                        senderJid: senderId,
                        emoji,
                        isHistory,
                    },
                    'reaction.saved'
                )
            } else {
                await removeReaction(targetMessageId, senderId, reactedAt)
                ingestLog(
                    {
                        messageId,
                        targetMessageId,
                        groupJid: jid,
                        senderJid: senderId,
                        isHistory,
                    },
                    'reaction.removed'
                )
            }
            return 'reaction'
        } catch (err) {
            log.error(
                {
                    err,
                    messageId,
                    targetMessageId,
                    groupJid: jid,
                    senderJid: senderId,
                },
                'reaction.save_failed'
            )
            return 'error'
        }
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
        } catch (err) {
            log.warn(
                { err, messageId, groupJid: jid, groupName, messageType, isHistory },
                'media.download_failed'
            )
        }
    }

    if (!messageId) return 'ignored'

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
        ingestLog(
            {
                messageId,
                groupJid: jid,
                groupName,
                senderJid: senderId,
                senderName,
                messageType,
                hasMedia: Boolean(mediaPath),
                isHistory,
            },
            'message.ingested'
        )
        return 'saved'
    } catch (err) {
        log.error(
            { err, messageId, groupJid: jid, senderJid: senderId, messageType },
            'message.insert_failed'
        )
        return 'error'
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
            log.info('whatsapp.qr_ready')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
            const loggedOut = statusCode === DisconnectReason.loggedOut
            log.warn(
                { statusCode, loggedOut, err: lastDisconnect?.error },
                'whatsapp.disconnected'
            )
            if (loggedOut) {
                log.warn('whatsapp.logged_out')
                clearAuthContents(config.authDir)
            }
            connectToWhatsApp()
        } else if (connection === 'open') {
            log.info({ jid: ownJid(sock) }, 'whatsapp.connected')

            const response = await sock.groupFetchAllParticipating()
            let cached = 0
            for (const key in response) {
                const metadata = response[key]
                if (!metadata) continue
                if (await persistMatchingGroup(metadata)) cached += 1
            }
            log.info({ matchingGroups: cached, pattern: config.groupPatternSource }, 'groups.cached')
        }
    })

    sock.ev.on('messaging-history.set', async ({ messages, contacts, syncType }) => {
        const started = Date.now()
        const counts = { saved: 0, reaction: 0, ignored: 0, error: 0 }
        log.info(
            { syncType, messages: messages?.length || 0, contacts: contacts?.length || 0 },
            'history.sync.start'
        )

        for (const m of messages || []) {
            await waitHistoryRead()
            counts[await processMessage(m, sock, true)] += 1
        }
        log.info(
            { syncType, ms: Date.now() - started, ...counts },
            'history.sync.done'
        )
    })

    const MessageEditEncType = proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT

    sock.ev.on('messages.upsert', async (event) => {
        if (event.type == 'notify') {
            for (const m of event.messages) {
                const secEncMsg = m.message?.secretEncryptedMessage
                if (secEncMsg?.secretEncType === MessageEditEncType) {
                    const targetMsgId = secEncMsg.targetMessageKey?.id
                    if (!targetMsgId) continue
                    const storedSecret = await getMessageSecret(targetMsgId)
                    if (!storedSecret) {
                        log.warn(
                            { targetMessageId: targetMsgId, groupJid: m.key.remoteJid },
                            'message.edit_secret_missing'
                        )
                        continue
                    }
                    const msgSec = new Uint8Array(JSON.parse(storedSecret))
                    try {
                        const decryptedMessage: WAProto.IMessage = decryptEditedMessage(secEncMsg, {
                            secret: msgSec,
                            id: targetMsgId,
                            sender: m.key.participant || m.participant || m.key.remoteJid || '',
                        })
                        const editedMessage =
                            decryptedMessage.protocolMessage?.editedMessage?.conversation ??
                            decryptedMessage.protocolMessage?.editedMessage?.imageMessage?.caption ??
                            ''
                        await markMessageEdited(targetMsgId, editedMessage)
                        log.info(
                            { messageId: targetMsgId, groupJid: m.key.remoteJid },
                            'message.edited'
                        )
                    } catch (err) {
                        log.warn(
                            { err, targetMessageId: targetMsgId, groupJid: m.key.remoteJid },
                            'message.edit_decrypt_failed'
                        )
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
            log.info({ count: deletedIds.length, messageIds: deletedIds }, 'messages.deleted')
        }
    })

    sock.ev.on('messages.delete', async (e) => {
        if ('keys' in e) {
            const ids = e.keys.map((k) => k.id).filter((id): id is string => Boolean(id))
            await markMessagesDeleted(ids)
            log.info({ count: ids.length, messageIds: ids }, 'messages.deleted')
            return
        }
        log.warn({ groupJid: e.jid }, 'messages.deleted_all')
    })

    sock.ev.on('groups.upsert', async (groups) => {
        for (const group of groups) {
            const tracked = await persistMatchingGroup(group)
            if (tracked) {
                log.info({ groupJid: group.id, groupName: group.subject }, 'group.tracked')
            }
        }
    })

    sock.ev.on('groups.update', async (events) => {
        for (const event of events) {
            if (!event?.id) continue
            const previous = await getGroupMetadata(event.id)
            if (event.subject && previous && event.subject !== previous.subject) {
                log.info(
                    {
                        groupJid: event.id,
                        from: previous.subject,
                        to: event.subject,
                    },
                    'group.renamed'
                )
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
            log.debug(
                {
                    groupJid: event.id,
                    groupName: metadata.subject,
                    action: event.action,
                    participants: event.participants.length,
                },
                'group.participants_updated'
            )
        }
    })

    sock.ev.on('creds.update', saveCreds)
}

;(async () => {
    try {
        log.info({ pattern: config.groupPatternSource, logLevel: config.logLevel }, 'agent.starting')
        await initDb()
        startApi()
        await connectToWhatsApp()
    } catch (err) {
        log.error({ err }, 'agent.start_failed')
        process.exit(1)
    }
})()
