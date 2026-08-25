import makeWASocket, {
    DisconnectReason,
    downloadMediaMessage,
    getContentType,
    type GroupMetadata,
    isJidGroup,
    jidDecode,
    jidNormalizedUser,
    normalizeMessageContent,
    proto,
    useMultiFileAuthState,
    type WAMessage,
    type WASocket,
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
import { createCatchup, asCatchupMessage } from './catchup.js'
import { config, matchesGroupPattern } from './config.js'
import { log } from './log.js'
import {
    deleteGroupMetadata,
    getGroupMetadata,
    setGroupMetadata,
} from './cache.js'
import {
    getLatestGroupMessage,
    getStoredMessageContent,
    hasMessage,
    initDb,
    insertMessage,
    markGroupDeleted,
    markMessagesDeleted,
    removeReaction,
    attachNearbyAlbumMedia,
    findRecentAlbumParent,
    updateMessageMediaPath,
    upsertGroup,
    upsertReaction,
    upsertSender,
} from './db.js'
import {
    applyEditUpdate,
    applyIncomingEdit,
    applyPlaintextEdit,
    extractMessageSecret,
    flushPendingEdits,
    isEditEnvelope,
    isEditedWrapper,
    rememberMessageSecret,
    textFromMessage,
} from './edits.js'
import { createSerialQueue, waitMediaDownload } from './rateLimit.js'

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

function secondsFromMillis(value: unknown, fallback: number): number {
    const millis = Number(value)
    return Number.isFinite(millis) && millis > 0 ? Math.floor(millis / 1000) : fallback
}

function albumParentIdOf(message: proto.IMessage | null | undefined): string | null {
    const association = message?.messageContextInfo?.messageAssociation
    const parentId = association?.parentMessageKey?.id
    if (!parentId) return null
    const type = association?.associationType
    if (
        type !== undefined &&
        type !== proto.MessageAssociation.AssociationType.MEDIA_ALBUM
    ) {
        return null
    }
    return parentId
}

async function storeMediaFile(
    m: WAMessage,
    sock: WASocket,
    {
        messageId,
        groupJid,
        groupName,
        messageType,
        timestamp,
        isHistory,
    }: {
        messageId: string
        groupJid: string
        groupName: string
        messageType: string
        timestamp: number
        isHistory: boolean
    }
): Promise<string | null> {
    if (!fileTypes[messageType]) return null
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
        await updateMessageMediaPath(messageId, fileName)
        return fileName
    } catch (err) {
        log.warn(
            { err, messageId, groupJid, groupName, messageType, isHistory },
            'media.download_failed'
        )
        return null
    }
}

async function resolveGroupMetadata(jid: string, sock: WASocket): Promise<GroupMetadata | undefined> {
    const cached = await getGroupMetadata(jid)
    if (cached) return cached
    return refreshGroup(sock, jid)
}

async function processMessage(
    m: WAMessage,
    sock: WASocket,
    isHistory = false
): Promise<'ignored' | 'saved' | 'reaction' | 'error' | 'edited'> {
    if (!m.message || !m.key.remoteJid) return 'ignored'
    if (isEditEnvelope(m.message)) return 'ignored'

    const jid = m.key.remoteJid
    if (!isJidGroup(jid)) return 'ignored'

    const groupMetadata = await resolveGroupMetadata(jid, sock)
    if (!groupMetadata) return 'ignored'

    const groupName = groupMetadata.subject
    if (!matchesGroupPattern(groupName)) return 'ignored'

    const messageId = m.key.id
    const content = normalizeMessageContent(m.message) || m.message
    const messageType = getContentType(content) || 'unknown'
    const rawSender = m.key.fromMe
        ? sock.user?.id
        : (m.key.participant || m.participant)

    const senderId = rawSender ? jidNormalizedUser(rawSender) : jid
    const senderName = m.pushName || jidDecode(senderId)?.user || ''
    const timestamp = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)
    const ingestLog = isHistory ? log.debug.bind(log) : log.info.bind(log)
    const messageSecret = extractMessageSecret(m.message)
    const alreadyEdited = isEditedWrapper(m.message)

    if (messageType === 'protocolMessage') return 'ignored'
    if (messageId && (await hasMessage(messageId))) {
        await rememberMessageSecret(messageId, messageSecret)
        if (alreadyEdited) {
            const editedText = textFromMessage(m.message)
            if (editedText != null) {
                const result = await applyPlaintextEdit(messageId, editedText, {
                    groupJid: jid,
                    isHistory,
                })
                if (result === 'applied') return 'edited'
            }
        }
        if (messageType !== 'reactionMessage') return 'ignored'
    }

    const reaction = content.reactionMessage
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

    const textContent = textFromMessage(content)
    const replyToId = content.extendedTextMessage?.contextInfo?.stanzaId || null
    const quotedMessage =
        content.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
        content.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.caption ||
        null

    let albumParentId = albumParentIdOf(content)
    if (
        !albumParentId &&
        (messageType === 'imageMessage' || messageType === 'videoMessage')
    ) {
        albumParentId = await findRecentAlbumParent(jid, senderId, timestamp)
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
            mediaPath: null,
            replyToId,
            quotedMessage,
            albumParentId,
            timestamp,
            isEdited: alreadyEdited,
            isHistory,
        })
        if (messageId) await flushPendingEdits(messageId)
        if (messageType === 'albumMessage') {
            await attachNearbyAlbumMedia({
                parentId: messageId,
                groupJid: jid,
                senderJid: senderId,
                timestamp,
            })
        }
        const mediaMeta = {
            messageId,
            groupJid: jid,
            groupName,
            messageType,
            timestamp,
            isHistory,
        }
        if (isHistory) void storeMediaFile(m, sock, mediaMeta)
        else await storeMediaFile(m, sock, mediaMeta)
        ingestLog(
            {
                messageId,
                groupJid: jid,
                groupName,
                senderJid: senderId,
                senderName,
                messageType,
                hasMedia: Boolean(fileTypes[messageType]),
                albumParentId,
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
        getMessage: async (key) => {
            if (!key.id) return undefined
            const text = await getStoredMessageContent(key.id)
            return text ? { conversation: text } : undefined
        },
    })
    const catchup = createCatchup(sock)
    const runIngest = createSerialQueue()

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
            log.info('whatsapp.qr_ready')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
            const loggedOut = statusCode === DisconnectReason.loggedOut
            const restartRequired = statusCode === DisconnectReason.restartRequired
            if (loggedOut) {
                log.warn({ statusCode, loggedOut }, 'whatsapp.logged_out')
                clearAuthContents(config.authDir)
            } else if (restartRequired) {
                log.info({ statusCode }, 'whatsapp.restart_required')
            } else {
                log.warn(
                    { statusCode, loggedOut, err: lastDisconnect?.error },
                    'whatsapp.disconnected'
                )
            }
            catchup.stop()
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
            log.info(
                {
                    matchingGroups: cached,
                    pattern: config.groupPatternSource,
                    catchupWindowSeconds: config.catchupWindowSeconds,
                },
                'groups.cached'
            )
            catchup.noteConnected()
        }
    })

    sock.ev.on('messaging-history.set', (event) => {
        catchup.noteHistoryChunk()
        void runIngest(async () => {
            const { messages, contacts, syncType } = event
            const started = Date.now()
            const counts = { saved: 0, reaction: 0, ignored: 0, error: 0, edited: 0 }
            const latestBefore = new Map<string, number | undefined>()
            log.info(
                { syncType, messages: messages?.length || 0, contacts: contacts?.length || 0 },
                'history.sync.start'
            )

            for (const m of messages || []) {
                const groupJid = m.key.remoteJid
                if (groupJid && !latestBefore.has(groupJid)) {
                    const latest = await getLatestGroupMessage(groupJid)
                    latestBefore.set(groupJid, latest?.timestamp)
                }
                counts[await processMessage(m, sock, true)] += 1
            }
            for (const m of messages || []) {
                const result = await applyIncomingEdit(m, true)
                if (result === 'applied') counts.edited += 1
            }
            await catchup.considerHistoryBatch(messages || [], syncType, latestBefore)
            log.info(
                { syncType, ms: Date.now() - started, ...counts },
                'history.sync.done'
            )
        })
    })

    sock.ev.on('messaging-history.status', (status) => {
        catchup.noteHistoryStatus(status.syncType, status.status)
    })

    sock.ev.on('messages.upsert', (event) => {
        void runIngest(async () => {
            if (event.type !== 'notify' && event.type !== 'append') return
            const isHistory = event.type === 'append' || Boolean(event.requestId)
            for (const m of event.messages) {
                if (!isEditEnvelope(m.message)) {
                    await catchup.considerMessage(
                        m,
                        event.requestId ? 'phone_unavailable' : event.type
                    )
                }
            }
            for (const m of event.messages) {
                await processMessage(m, sock, isHistory)
            }
            for (const m of event.messages) {
                await applyIncomingEdit(m, isHistory)
            }
        })
    })

    sock.ev.on('messages.update', (updates) => {
        void runIngest(async () => {
            const deletedIds: string[] = []
            for (const u of updates) {
                if (u.update.messageStubType === 1 && u.key.id) {
                    deletedIds.push(u.key.id)
                }
                if (u.update.message) {
                    await applyEditUpdate(u.key, u.update.message)
                }
            }
            if (deletedIds.length > 0) {
                await markMessagesDeleted(deletedIds)
                log.info({ count: deletedIds.length, messageIds: deletedIds }, 'messages.deleted')
            }
        })
    })

    sock.ev.on('messages.delete', (e) => {
        void runIngest(async () => {
            if ('keys' in e) {
                const ids = e.keys.map((k) => k.id).filter((id): id is string => Boolean(id))
                await markMessagesDeleted(ids)
                log.info({ count: ids.length, messageIds: ids }, 'messages.deleted')
                return
            }
            log.warn({ groupJid: e.jid }, 'messages.deleted_all')
        })
    })

    sock.ev.on('chats.upsert', async (chats) => {
        for (const chat of chats) {
            const last = asCatchupMessage(chat.messages?.[0]?.message)
            if (last) await catchup.considerMessage(last, 'chat.upsert')
        }
    })

    sock.ev.on('chats.update', async (updates) => {
        for (const chat of updates) {
            const last = asCatchupMessage(chat.messages?.[0]?.message)
            if (last) await catchup.considerMessage(last, 'chat.update')
        }
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
