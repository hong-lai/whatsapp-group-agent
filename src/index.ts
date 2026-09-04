import makeWASocket, {
    DisconnectReason,
    downloadMediaMessage,
    getContentType,
    type BaileysEventMap,
    type Contact,
    type GroupMetadata,
    type LIDMapping,
    isHostedLidUser,
    isHostedPnUser,
    isJidGroup,
    isLidUser,
    isPnUser,
    jidNormalizedUser,
    normalizeMessageContent,
    proto,
    useMultiFileAuthState,
    type WAMessage,
    type WASocket,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'fs'
import { basename, extname, join } from 'path'
import { pipeline } from 'stream/promises'
import type { Readable } from 'stream'
import logger from '@whiskeysockets/baileys/lib/Utils/logger.js'
import pino from 'pino'
import { startApi } from './api.js'
import { createCatchup, asCatchupMessage } from './catchup.js'
import { config, matchesGroupPattern } from './config.js'
import { noteConnected, noteConnecting, noteDisconnected } from './connection.js'
import {
    buildMediaFilename,
    filenameTypeForMessage,
    getFilenameFormatSettings,
    loadFilenameFormatSettings,
    uniqueMediaPath,
} from './filenameFormat.js'
import { firstAvailableName, hktStamp, safePathSegment, withDeletedSuffix } from './hkt.js'
import { log } from './log.js'
import {
    addSkippedGroup,
    clearParticipatingMeta,
    clearSkippedGroups,
    deleteGroupMetadata,
    deleteParticipatingMeta,
    getGroupMetadata,
    getParticipatingMeta,
    getSenderDisplayNames,
    isSkippedGroup,
    listParticipatingMeta,
    removeSkippedGroup,
    resolveLinkedJids,
    setGroupMetadata,
    setLidPnMapping,
    setParticipatingMeta,
    setSenderDisplayNames,
} from './cache.js'
import {
    getLatestGroupMessage,
    getStoredMessageContent,
    hasMessage,
    initDb,
    insertMessage,
    markGroupDeleted,
    markMessageForwarded,
    markMessagesDeleted,
    removeReaction,
    attachNearbyAlbumMedia,
    resolveAlbumParent,
    nextAlbumIndex,
    updateAlbumExpected,
    updateAlbumLink,
    updateMessageMediaPath,
    upsertGroup,
    upsertReaction,
    upsertSenders,
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
import { createSerialQueue, retryBackoffMs, sleep, waitMediaDownload } from './rateLimit.js'
import { enqueueMessageEvent } from './queue/index.js'

const fileTypes: Record<string, string> = {
    imageMessage: 'jpeg',
    videoMessage: 'mp4',
    ptvMessage: 'mp4',
    stickerMessage: 'webp',
    documentMessage: 'pdf',
    audioMessage: 'ogg',
}

function isAlbumMediaType(messageType: string): boolean {
    return (
        messageType === 'imageMessage' ||
        messageType === 'videoMessage' ||
        messageType === 'ptvMessage'
    )
}

const mimeExtensions: Record<string, string> = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
    'application/rtf': 'rtf',
    'application/zip': 'zip',
    'application/vnd.rar': 'rar',
    'application/x-7z-compressed': '7z',
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
}

function originalMediaName(
    content: proto.IMessage | null | undefined,
    fallbackExt: string
): string | null {
    const media =
        content?.documentMessage ||
        content?.imageMessage ||
        content?.videoMessage ||
        content?.ptvMessage ||
        content?.audioMessage ||
        content?.stickerMessage
    if (!media) return null
    const named = media as {
        fileName?: string | null
        title?: string | null
        mimetype?: string | null
    }
    const raw = (named.fileName || named.title || '').trim()
    if (!raw) return null
    const name = basename(raw.replace(/\\/g, '/'))
    if (!name || name === '.' || name === '..') return null
    if (extname(name).length > 1) return name
    const mime = named.mimetype?.split(';')[0]?.trim().toLowerCase()
    const fromMime = mime ? mimeExtensions[mime] : undefined
    return `${name}.${fromMime || fallbackExt}`
}

type NamedContact = Pick<Contact, 'id' | 'lid' | 'phoneNumber' | 'name' | 'notify' | 'verifiedName'>

function isPersonJid(jid: string | undefined | null): jid is string {
    if (!jid) return false
    return Boolean(isPnUser(jid) || isLidUser(jid) || isHostedPnUser(jid) || isHostedLidUser(jid))
}

function usableDisplayName(value: string | undefined | null): string {
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

async function linkedJids(...jids: Array<string | undefined | null>): Promise<string[]> {
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

async function cachedSenderName(...jids: Array<string | undefined | null>): Promise<string> {
    const linked = await linkedJids(...jids)
    const names = await getSenderDisplayNames(linked)
    for (const jid of linked) {
        const name = names.get(jid)
        if (name) return name
    }
    return ''
}

function nameFromGroup(
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

async function rememberContacts(contacts: Array<Partial<NamedContact>> | undefined): Promise<void> {
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

async function rememberLidMappings(mappings: LIDMapping[] | undefined): Promise<void> {
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

function ownUser(sock: WASocket): { id?: string; lid?: string; name?: string } | undefined {
    return sock.user as { id?: string; lid?: string; name?: string } | undefined
}

async function rememberMessageSender(
    senderId: string,
    altSender: string | undefined,
    senderName: string
): Promise<void> {
    const jids = (await linkedJids(senderId, altSender)).filter(isPersonJid)
    if (jids.length === 0) return
    await upsertSenders(jids.map((jid) => ({ jid, displayName: senderName })))
}

function isRateOverlimit(err: unknown): boolean {
    return String(err).includes('rate-overlimit')
}

function mergeDefined<T extends object>(base: T, patch: Partial<T>): T {
    const next = { ...base }
    for (const key of Object.keys(patch) as (keyof T)[]) {
        const value = patch[key]
        if (value !== undefined) next[key] = value as T[keyof T]
    }
    return next
}

function ownJid(sock: WASocket): string | undefined {
    const id = sock.user?.id
    return id ? jidNormalizedUser(id) : undefined
}

async function persistMatchingGroup(metadata: GroupMetadata): Promise<boolean> {
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

async function forgetGroup(jid: string, reason: string): Promise<void> {
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

async function refreshGroup(
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

function unixSeconds(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000)
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

function historyCutoffSeconds(): number {
    return Math.floor(Date.now() / 1000) - config.catchupBackfillSeconds
}

function secondsFromMillis(value: unknown, fallback: number): number {
    const millis = Number(value)
    return Number.isFinite(millis) && millis > 0 ? Math.floor(millis / 1000) : fallback
}

function asAlbumIndex(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
        return Math.trunc(Number(value))
    }
    if (typeof value === 'bigint') return Number(value)
    if (
        value &&
        typeof value === 'object' &&
        'toNumber' in value &&
        typeof (value as { toNumber: unknown }).toNumber === 'function'
    ) {
        const n = (value as { toNumber: () => number }).toNumber()
        return Number.isFinite(n) ? Math.trunc(n) : null
    }
    return null
}

function messageLayers(
    message: proto.IMessage | null | undefined
): Array<proto.IMessage | null | undefined> {
    const layers: Array<proto.IMessage | null | undefined> = []
    let current = message
    for (let i = 0; i < 6 && current; i += 1) {
        layers.push(current)
        current =
            current.associatedChildMessage?.message ||
            current.ephemeralMessage?.message ||
            current.viewOnceMessage?.message ||
            current.viewOnceMessageV2?.message ||
            current.viewOnceMessageV2Extension?.message ||
            current.editedMessage?.message ||
            current.documentWithCaptionMessage?.message ||
            undefined
    }
    return layers
}

function associationTypeOf(value: unknown): number | null {
    if (value == null) return null
    if (typeof value === 'object' && value !== null && 'toNumber' in value) {
        try {
            return Number((value as { toNumber: () => number }).toNumber())
        } catch {
            return null
        }
    }
    const n = Number(value)
    return Number.isFinite(n) ? n : null
}

function albumAssociationOf(
    ...messages: Array<proto.IMessage | null | undefined>
): { parentId: string | null; index: number | null } {
    for (const message of messages) {
        for (const layer of messageLayers(message)) {
            const raw = layer?.messageContextInfo?.messageAssociation as
                | (proto.IMessageAssociation & {
                      message_index?: unknown
                      parent_message_key?: { id?: string | null } | null
                      association_type?: unknown
                  })
                | null
                | undefined
            if (!raw) continue
            const parentId = raw.parentMessageKey?.id || raw.parent_message_key?.id || null
            if (!parentId) continue
            const type = associationTypeOf(raw.associationType ?? raw.association_type)
            // Native album children carry MEDIA_ALBUM. Some payloads omit the enum
            // (undefined) or leave UNKNOWN while still setting parentMessageKey.
            if (
                type != null &&
                type !== proto.MessageAssociation.AssociationType.UNKNOWN &&
                type !== proto.MessageAssociation.AssociationType.MEDIA_ALBUM
            ) {
                continue
            }
            return {
                parentId,
                index: asAlbumIndex(raw.messageIndex ?? raw.message_index),
            }
        }
    }
    return { parentId: null, index: null }
}

function albumMessageFields(
    album: proto.Message.IAlbumMessage | null | undefined
): Record<string, unknown> | null {
    if (!album) return null
    if (typeof (album as proto.Message.AlbumMessage).toJSON === 'function') {
        return (album as proto.Message.AlbumMessage).toJSON() as Record<string, unknown>
    }
    return album as Record<string, unknown>
}

function albumExpectedOf(
    ...messages: Array<proto.IMessage | null | undefined>
): { images: number | null; videos: number | null } {
    for (const message of messages) {
        for (const layer of messageLayers(message)) {
            const record = albumMessageFields(layer?.albumMessage)
            if (!record) continue
            const images = asAlbumIndex(record.expectedImageCount ?? record.expected_image_count)
            const videos = asAlbumIndex(record.expectedVideoCount ?? record.expected_video_count)
            const hasImages = images != null && images > 0
            const hasVideos = videos != null && videos > 0
            // History sync often omits these fields. protobufjs then surfaces the
            // uint32 default 0, which must not be stored as a real slot limit.
            if (!hasImages && !hasVideos) continue
            return {
                images: hasImages ? images : images === 0 ? 0 : null,
                videos: hasVideos ? videos : videos === 0 ? 0 : null,
            }
        }
    }
    return { images: null, videos: null }
}

function contentForIngest(message: proto.IMessage | null | undefined): proto.IMessage | null | undefined {
    if (!message) return message
    if (message.imageMessage && message.associatedChildMessage) {
        const rest = { ...message, associatedChildMessage: null }
        return normalizeMessageContent(rest) || rest
    }
    return normalizeMessageContent(message) || message
}

function isLivePhotoMotionVideo(
    raw: proto.IMessage | null | undefined,
    content: proto.IMessage | null | undefined
): boolean {
    if (raw?.imageMessage) return false
    const video = content?.videoMessage || content?.ptvMessage || raw?.videoMessage || raw?.ptvMessage
    if (!video) return false
    const association =
        raw?.messageContextInfo?.messageAssociation?.associationType ??
        content?.messageContextInfo?.messageAssociation?.associationType
    if (association === proto.MessageAssociation.AssociationType.MOTION_PHOTO) return true
    if (video.contextInfo?.pairedMediaType === proto.ContextInfo.PairedMediaType.MOTION_PHOTO_CHILD) {
        return true
    }
    return video.motionPhotoPresentationOffsetMs != null
}

function messageForMediaDownload(m: WAMessage): WAMessage {
    const msg = m.message
    if (!msg?.imageMessage || !msg.associatedChildMessage) return m
    return { ...m, message: { ...msg, associatedChildMessage: null } }
}

function contextInfoOf(content: proto.IMessage | null | undefined): proto.IContextInfo | undefined {
    if (!content) return undefined
    return (
        content.extendedTextMessage?.contextInfo ||
        content.imageMessage?.contextInfo ||
        content.videoMessage?.contextInfo ||
        content.ptvMessage?.contextInfo ||
        content.documentMessage?.contextInfo ||
        content.audioMessage?.contextInfo ||
        content.stickerMessage?.contextInfo ||
        content.buttonsMessage?.contextInfo ||
        content.templateMessage?.contextInfo ||
        content.listMessage?.contextInfo ||
        content.interactiveMessage?.contextInfo ||
        content.contactMessage?.contextInfo ||
        content.contactsArrayMessage?.contextInfo ||
        content.locationMessage?.contextInfo ||
        content.liveLocationMessage?.contextInfo ||
        content.albumMessage?.contextInfo ||
        undefined
    )
}

function isForwardedContent(content: proto.IMessage | null | undefined): boolean {
    const ctx = contextInfoOf(content)
    if (!ctx) return false
    return Boolean(
        ctx.isForwarded ||
            (ctx.forwardingScore ?? 0) > 0 ||
            ctx.forwardedNewsletterMessageInfo ||
            ctx.businessMessageForwardInfo
    )
}

function mentionedJidsOf(content: proto.IMessage | null | undefined): string[] {
    const ctx = contextInfoOf(content)
    const mentioned = (ctx?.mentionedJid || []).filter(isPersonJid).map((jid) => jidNormalizedUser(jid))
    const quoted = ctx?.quotedMessage ? mentionedJidsOf(ctx.quotedMessage) : []
    const seen = new Set<string>()
    const out: string[] = []
    for (const jid of [...mentioned, ...quoted]) {
        if (seen.has(jid)) continue
        seen.add(jid)
        out.push(jid)
    }
    return out
}

function suffixDeletedMediaFile(currentPath: string): string | null {
    const preferred = withDeletedSuffix(currentPath)
    if (preferred === currentPath) {
        return existsSync(currentPath) ? currentPath : null
    }
    if (existsSync(currentPath)) {
        const dest = firstAvailableName(preferred, existsSync)
        try {
            renameSync(currentPath, dest)
            return dest
        } catch (err) {
            log.warn({ err, from: currentPath, to: dest }, 'media.delete_rename_failed')
            if (existsSync(currentPath)) return currentPath
            if (existsSync(preferred)) return preferred
            return null
        }
    }
    return existsSync(preferred) ? preferred : null
}

async function persistMediaPath(messageId: string, filePath: string): Promise<string> {
    const isDeleted = await updateMessageMediaPath(messageId, filePath)
    if (!isDeleted) return filePath
    const deletedPath = suffixDeletedMediaFile(filePath)
    if (!deletedPath || deletedPath === filePath) return filePath
    await updateMessageMediaPath(messageId, deletedPath)
    log.info({ messageId, from: filePath, to: deletedPath }, 'media.deleted_renamed')
    return deletedPath
}

function enqueueMediaReady(meta: MediaStoreMeta, mediaPath: string): void {
    void enqueueMessageEvent({
        event: 'message.media_ready',
        messageId: meta.messageId,
        groupJid: meta.groupJid,
        messageType: meta.messageType,
        mediaPath,
        isHistory: meta.isHistory,
    })
}

async function markDeletedAndRenameMedia(messageIds: string[]): Promise<void> {
    const rows = await markMessagesDeleted(messageIds)
    for (const row of rows) {
        if (!row.mediaPath) continue
        const deletedPath = suffixDeletedMediaFile(row.mediaPath)
        if (!deletedPath || deletedPath === row.mediaPath) continue
        await updateMessageMediaPath(row.messageId, deletedPath)
        log.info(
            { messageId: row.messageId, from: row.mediaPath, to: deletedPath },
            'media.deleted_renamed'
        )
    }
    for (const messageId of messageIds) {
        void enqueueMessageEvent({
            event: 'message.deleted',
            messageId,
            groupJid: null,
            messageType: null,
            mediaPath: null,
            isHistory: false,
        })
    }
}

type MediaStoreMeta = {
    messageId: string
    groupJid: string
    groupName: string
    messageType: string
    timestamp: number
    isHistory: boolean
    senderName: string
    albumIndex: number | null
}

function mediaErrorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

function isTimeoutMediaError(err: unknown): boolean {
    const error = mediaErrorText(err)
    return error.includes('Connect Timeout') || error.includes('fetch failed')
}

function isRetryableMediaError(err: unknown): boolean {
    const error = mediaErrorText(err)
    return (
        isTimeoutMediaError(err) ||
        /ETIMEDOUT|ENETUNREACH|EAI_AGAIN|ECONNRESET|ECONNREFUSED|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|socket hang up/i.test(
            error
        )
    )
}

function removePartialMedia(fileName: string): void {
    if (!existsSync(fileName)) return
    try {
        unlinkSync(fileName)
    } catch {
        // ignore leftover partials
    }
}

async function mediaDestPath(
    m: WAMessage,
    meta: MediaStoreMeta,
    fallbackExt: string
): Promise<string> {
    const { date: hktDate } = hktStamp(meta.timestamp)
    const safeFolderName = safePathSegment(meta.groupName, meta.groupJid)
    const folderPath = `${config.downloadDir}/${safeFolderName}/${hktDate}`
    if (!existsSync(folderPath)) {
        mkdirSync(folderPath, { recursive: true })
    }
    const originalName = originalMediaName(
        contentForIngest(m.message) || m.message,
        fallbackExt
    )
    const filenameType = filenameTypeForMessage(meta.messageType)
    const settings = await getFilenameFormatSettings()
    const typePattern = filenameType ? settings[filenameType] : settings.images
    return uniqueMediaPath(
        folderPath,
        buildMediaFilename(typePattern, {
            timestamp: meta.timestamp,
            originalName,
            groupName: meta.groupName,
            messageId: meta.messageId,
            mediaIndex: meta.albumIndex,
            senderName: meta.senderName,
            mediaPath: `media.${fallbackExt}`,
        }),
        existsSync
    )
}

async function downloadMediaOnce(
    m: WAMessage,
    sock: WASocket,
    fileName: string
): Promise<void> {
    await waitMediaDownload()
    const stream = (await downloadMediaMessage(
        messageForMediaDownload(m),
        'stream',
        {},
        {
            logger,
            reuploadRequest: sock.updateMediaMessage,
        }
    )) as Readable
    try {
        await pipeline(stream, createWriteStream(fileName))
    } catch (err) {
        stream.destroy()
        removePartialMedia(fileName)
        throw err
    }
}

function logMediaDownloadFailure(
    err: unknown,
    meta: MediaStoreMeta,
    attempts: number
): void {
    if (meta.isHistory && isTimeoutMediaError(err)) {
        log.debug(
            {
                messageId: meta.messageId,
                groupJid: meta.groupJid,
                groupName: meta.groupName,
                messageType: meta.messageType,
                attempts,
            },
            'media.history_unavailable'
        )
        return
    }
    log.warn(
        {
            err,
            messageId: meta.messageId,
            groupJid: meta.groupJid,
            groupName: meta.groupName,
            messageType: meta.messageType,
            isHistory: meta.isHistory,
            attempts,
        },
        'media.download_failed'
    )
}

async function retryMediaDownload(
    m: WAMessage,
    sock: WASocket,
    meta: MediaStoreMeta,
    fileName: string,
    firstErr: unknown
): Promise<void> {
    const maxAttempts = Math.max(1, config.mediaRetryMaxAttempts)
    let err = firstErr
    for (let failedAttempt = 1; failedAttempt < maxAttempts; failedAttempt++) {
        if (!isRetryableMediaError(err)) {
            logMediaDownloadFailure(err, meta, failedAttempt)
            return
        }
        const nextAttempt = failedAttempt + 1
        const delayMs = retryBackoffMs(failedAttempt, config.mediaRetryMinMs, config.mediaRetryMaxMs)
        log.warn(
            {
                err,
                messageId: meta.messageId,
                groupJid: meta.groupJid,
                groupName: meta.groupName,
                messageType: meta.messageType,
                isHistory: meta.isHistory,
                attempt: failedAttempt,
                nextAttempt,
                maxAttempts,
                delayMs,
            },
            'media.download_retry'
        )
        await sleep(delayMs)
        try {
            await downloadMediaOnce(m, sock, fileName)
            const storedPath = await persistMediaPath(meta.messageId, fileName)
            enqueueMediaReady(meta, storedPath)
            log.info(
                {
                    messageId: meta.messageId,
                    groupJid: meta.groupJid,
                    groupName: meta.groupName,
                    attempt: nextAttempt,
                    maxAttempts,
                    fileName: storedPath,
                },
                'media.download_recovered'
            )
            return
        } catch (nextErr) {
            err = nextErr
        }
    }
    logMediaDownloadFailure(err, meta, maxAttempts)
}

async function storeMediaFile(
    m: WAMessage,
    sock: WASocket,
    meta: MediaStoreMeta
): Promise<string | null> {
    const fallbackExt = fileTypes[meta.messageType]
    if (!fallbackExt) return null
    if (isLivePhotoMotionVideo(m.message, contentForIngest(m.message))) return null
    const fileName = await mediaDestPath(m, meta, fallbackExt)
    try {
        await downloadMediaOnce(m, sock, fileName)
        const storedPath = await persistMediaPath(meta.messageId, fileName)
        enqueueMediaReady(meta, storedPath)
        return storedPath
    } catch (err) {
        const maxAttempts = Math.max(1, config.mediaRetryMaxAttempts)
        if (isRetryableMediaError(err) && maxAttempts > 1) {
            void retryMediaDownload(m, sock, meta, fileName, err).catch((retryErr) => {
                log.warn(
                    {
                        err: retryErr,
                        messageId: meta.messageId,
                        groupJid: meta.groupJid,
                    },
                    'media.retry_loop_failed'
                )
            })
            return null
        }
        logMediaDownloadFailure(err, meta, 1)
        return null
    }
}

async function resolveGroupMetadata(
    jid: string,
    sock: WASocket,
    allowFetch: boolean
): Promise<GroupMetadata | undefined> {
    const cached = await getGroupMetadata(jid)
    const participating = await getParticipatingMeta(jid)
    const knownNonMatching = await isSkippedGroup(jid)
    if (cached) return cached
    if (participating) {
        if (matchesGroupPattern(participating.subject)) {
            await persistMatchingGroup(participating)
            return participating
        }
        await addSkippedGroup(jid)
        return undefined
    }
    if (knownNonMatching || !allowFetch) return undefined
    return refreshGroup(sock, jid, 'processMessage')
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

    const groupMetadata = await resolveGroupMetadata(jid, sock, !isHistory)
    if (!groupMetadata) return 'ignored'

    const groupName = groupMetadata.subject
    if (!matchesGroupPattern(groupName)) return 'ignored'

    const messageId = m.key.id
    const content = contentForIngest(m.message) || m.message
    const messageType = getContentType(content) || 'unknown'
    const me = ownUser(sock)
    const rawSender = m.key.fromMe
        ? me?.id || me?.lid
        : (m.key.participant || m.participant)

    const senderId = isPersonJid(rawSender) ? jidNormalizedUser(rawSender) : ''
    const altSender = isPersonJid(m.key.participantAlt)
        ? jidNormalizedUser(m.key.participantAlt)
        : undefined
    const senderName =
        (await cachedSenderName(senderId, altSender, m.key.fromMe ? me?.lid : undefined)) ||
        usableDisplayName(m.pushName) ||
        (m.key.fromMe ? usableDisplayName(me?.name) : '') ||
        nameFromGroup(groupMetadata, senderId, altSender) ||
        ''
    if (senderName) {
        const nameEntries = (await linkedJids(senderId, altSender)).map((personJid) => ({
            jid: personJid,
            name: senderName,
        }))
        await setSenderDisplayNames(nameEntries)
    }
    const timestamp = unixSeconds(m.messageTimestamp)
    if (isHistory && timestamp < historyCutoffSeconds()) return 'ignored'
    const ingestLog = isHistory ? log.debug.bind(log) : log.info.bind(log)
    const messageSecret = extractMessageSecret(m.message)
    const alreadyEdited = isEditedWrapper(m.message)
    const isForwarded = isForwardedContent(content)

    if (messageType === 'protocolMessage') return 'ignored'
    if (isLivePhotoMotionVideo(m.message, content)) {
        ingestLog(
            { messageId, groupJid: jid, groupName, isHistory },
            'media.live_photo_video_skipped'
        )
        return 'ignored'
    }
    if (messageId && (await hasMessage(messageId))) {
        await rememberMessageSecret(messageId, messageSecret)
        const association = albumAssociationOf(m.message, content)
        if (association.parentId) {
            // Native WhatsApp MEDIA_ALBUM association — trust parentMessageKey as-is.
            await updateAlbumLink(messageId, association.parentId, association.index)
        } else if (isAlbumMediaType(messageType) && isHistory) {
            // History sync often strips messageAssociation; fall back to nearby attach.
            const albumParentId = await resolveAlbumParent({
                groupJid: jid,
                senderJid: senderId || null,
                timestamp,
                messageType,
                explicitParentId: null,
                isHistory,
            })
            if (albumParentId) {
                await updateAlbumLink(messageId, albumParentId, null)
            }
        }
        if (messageType === 'albumMessage') {
            const expected = albumExpectedOf(m.message, content)
            await updateAlbumExpected(messageId, expected.images, expected.videos)
            if (isHistory) {
                try {
                    await attachNearbyAlbumMedia({
                        parentId: messageId,
                        groupJid: jid,
                        senderJid: senderId || null,
                        timestamp,
                        expectedImages: expected.images,
                        expectedVideos: expected.videos,
                    })
                } catch (err) {
                    log.warn(
                        { err, messageId, groupJid: jid, senderJid: senderId },
                        'album.nearby_attach_failed'
                    )
                }
            }
        }
        if (isForwarded) await markMessageForwarded(messageId)
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
            if (!senderId) return 'ignored'
            await upsertGroup(jid, groupName, true)
            await rememberMessageSender(senderId, altSender, senderName)
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
    const ctx = contextInfoOf(content)
    const replyToId = ctx?.stanzaId || content.extendedTextMessage?.contextInfo?.stanzaId || null
    const quotedRaw = ctx?.quotedMessage
    const quotedContent = quotedRaw ? contentForIngest(quotedRaw) || quotedRaw : null
    const quotedMessage =
        textFromMessage(quotedContent) ||
        quotedContent?.documentMessage?.fileName ||
        quotedContent?.documentMessage?.title ||
        content.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
        content.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.caption ||
        null

    const association = albumAssociationOf(m.message, content)
    const expected = albumExpectedOf(content, m.message)
    let albumParentId = association.parentId
    let albumIndex = association.index
    if (!albumParentId && isAlbumMediaType(messageType) && isHistory) {
        // History sync often strips messageAssociation; fall back to nearby attach.
        albumParentId = await resolveAlbumParent({
            groupJid: jid,
            senderJid: senderId || null,
            timestamp,
            messageType,
            explicitParentId: null,
            isHistory,
        })
        if (!albumParentId) albumIndex = null
    }
    if (albumParentId && albumIndex == null && isAlbumMediaType(messageType)) {
        albumIndex = await nextAlbumIndex(albumParentId)
    }

    if (!messageId) return 'ignored'

    try {
        await upsertGroup(jid, groupName, true)
        if (senderId) await rememberMessageSender(senderId, altSender, senderName)
        const mentioned = mentionedJidsOf(content)
        if (mentioned.length > 0) {
            await upsertSenders(
                await Promise.all(
                    mentioned.map(async (personJid) => ({
                        jid: personJid,
                        displayName:
                            (await cachedSenderName(personJid)) ||
                            nameFromGroup(groupMetadata, personJid) ||
                            '',
                    }))
                )
            )
        }
        await insertMessage({
            messageId,
            groupJid: jid,
            senderJid: senderId || null,
            messageSecret,
            messageType,
            textContent,
            mediaPath: null,
            fileName:
                messageType === 'documentMessage'
                    ? originalMediaName(content, fileTypes.documentMessage || 'pdf')
                    : null,
            replyToId,
            quotedMessage,
            albumParentId,
            albumIndex,
            albumExpectedImages: expected.images,
            albumExpectedVideos: expected.videos,
            timestamp,
            isEdited: alreadyEdited,
            isHistory,
            isForwarded,
        })
        if (messageId) await flushPendingEdits(messageId)
        if (messageType === 'albumMessage' && isHistory) {
            try {
                await attachNearbyAlbumMedia({
                    parentId: messageId,
                    groupJid: jid,
                    senderJid: senderId || null,
                    timestamp,
                    expectedImages: expected.images,
                    expectedVideos: expected.videos,
                })
            } catch (err) {
                log.warn(
                    { err, messageId, groupJid: jid, senderJid: senderId },
                    'album.nearby_attach_failed'
                )
            }
        }
        const hasMedia = Boolean(fileTypes[messageType])
        if (hasMedia && !config.skipMediaDownload) {
            const mediaMeta = {
                messageId,
                groupJid: jid,
                groupName,
                messageType,
                timestamp,
                isHistory,
                senderName,
                albumIndex: albumIndex ?? null,
            }
            if (isHistory) void storeMediaFile(m, sock, mediaMeta)
            else await storeMediaFile(m, sock, mediaMeta)
        }
        ingestLog(
            {
                messageId,
                groupJid: jid,
                groupName,
                senderJid: senderId,
                senderName,
                messageType,
                hasMedia,
                mediaSkipped: hasMedia && config.skipMediaDownload,
                albumParentId,
                albumIndex,
                albumAssociation: Boolean(association.parentId),
                ...(messageType === 'albumMessage'
                    ? {
                          albumExpectedImages: expected.images,
                          albumExpectedVideos: expected.videos,
                      }
                    : {}),
                isHistory,
                isForwarded,
            },
            'message.ingested'
        )
        void enqueueMessageEvent({
            event: 'message.created',
            messageId,
            groupJid: jid,
            messageType,
            mediaPath: null,
            isHistory,
        })
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

function hasIngestWork(events: Partial<BaileysEventMap>): boolean {
    return Boolean(
        events['messaging-history.set'] ||
            events['messaging-history.status'] ||
            events['lid-mapping.update'] ||
            events['contacts.upsert'] ||
            events['contacts.update'] ||
            events['messages.upsert'] ||
            events['messages.update'] ||
            events['messages.delete'] ||
            events['chats.upsert'] ||
            events['chats.update'] ||
            events['chats.delete'] ||
            events['groups.upsert'] ||
            events['groups.update'] ||
            events['group-participants.update']
    )
}

async function connectToWhatsApp() {
    noteConnecting()
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

    function handleConnectionUpdate(update: BaileysEventMap['connection.update']): void {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
            log.info('whatsapp.qr_ready')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'connecting') {
            noteConnecting()
        } else if (connection === 'close') {
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
            noteDisconnected(
                loggedOut
                    ? 'Logged out'
                    : restartRequired
                      ? 'Restart required'
                      : statusCode
                        ? `Connection closed (${statusCode})`
                        : 'Connection closed'
            )
            catchup.stop()
            void connectToWhatsApp()
        } else if (connection === 'open') {
            log.info({ jid: ownJid(sock) }, 'whatsapp.connected')
            noteConnected()
            void cacheParticipatingGroups()
        }
    }

    async function cacheParticipatingGroups(): Promise<void> {
        await clearSkippedGroups()
        await clearParticipatingMeta()
        const response = await sock.groupFetchAllParticipating()
        let cached = 0
        const trackedJids: string[] = []
        for (const key in response) {
            const metadata = response[key]
            if (!metadata) continue
            await setParticipatingMeta(metadata.id, metadata)
        }
        for (const metadata of await listParticipatingMeta()) {
            if (await persistMatchingGroup(metadata)) {
                cached += 1
                trackedJids.push(metadata.id)
            }
        }
        catchup.setTrackedGroups(trackedJids)
        log.info(
            {
                matchingGroups: cached,
                pattern: config.groupPatternSource,
                catchupBackfillSeconds: config.catchupBackfillSeconds,
            },
            'groups.cached'
        )
        catchup.noteConnected()
    }

    async function ingestEvents(events: Partial<BaileysEventMap>): Promise<void> {
        const history = events['messaging-history.set']
        if (history) {
            const { messages, contacts, syncType, lidPnMappings } = history
            const started = Date.now()
            const counts = { saved: 0, reaction: 0, ignored: 0, error: 0, edited: 0, tooOld: 0 }
            const latestBefore = new Map<string, number | undefined>()
            const cutoff = historyCutoffSeconds()

            await rememberLidMappings(lidPnMappings)
            await rememberContacts(contacts)

            for (const m of messages || []) {
                if (unixSeconds(m.messageTimestamp) < cutoff) {
                    counts.tooOld += 1
                    continue
                }
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
            catchup.noteHistoryChunk(syncType)
            log.info({ syncType, ms: Date.now() - started, ...counts }, 'history.sync.done')
        }

        if (events['lid-mapping.update']) {
            await rememberLidMappings([events['lid-mapping.update']])
        }
        if (events['contacts.upsert']) {
            await rememberContacts(events['contacts.upsert'])
        }
        if (events['contacts.update']) {
            await rememberContacts(events['contacts.update'])
        }

        for (const chat of events['chats.upsert'] || []) {
            const last = asCatchupMessage(chat.messages?.[0]?.message)
            if (last) {
                catchup.noteChatHead(last)
                await catchup.considerMessage(last, 'chat.upsert')
            }
        }
        for (const chat of events['chats.update'] || []) {
            const last = asCatchupMessage(chat.messages?.[0]?.message)
            if (last) {
                catchup.noteChatHead(last)
                await catchup.considerMessage(last, 'chat.update')
            }
        }

        const upsert = events['messages.upsert']
        if (upsert && (upsert.type === 'notify' || upsert.type === 'append')) {
            const isHistory = upsert.type === 'append' || Boolean(upsert.requestId)
            for (const m of upsert.messages) {
                if (!isEditEnvelope(m.message)) {
                    catchup.noteChatHead(m)
                    await catchup.considerMessage(
                        m,
                        upsert.requestId ? 'phone_unavailable' : upsert.type
                    )
                }
            }
            for (const m of upsert.messages) {
                await processMessage(m, sock, isHistory)
            }
            for (const m of upsert.messages) {
                await applyIncomingEdit(m, isHistory)
            }
        }

        if (events['messages.update']) {
            const deletedIds: string[] = []
            for (const u of events['messages.update']) {
                if (u.update.messageStubType === 1 && u.key.id) {
                    deletedIds.push(u.key.id)
                }
                if (u.update.message) {
                    await applyEditUpdate(u.key, u.update.message)
                }
            }
            if (deletedIds.length > 0) {
                await markDeletedAndRenameMedia(deletedIds)
                log.info({ count: deletedIds.length, messageIds: deletedIds }, 'messages.deleted')
            }
        }

        const deleted = events['messages.delete']
        if (deleted) {
            if ('keys' in deleted) {
                const ids = deleted.keys.map((k) => k.id).filter((id): id is string => Boolean(id))
                await markDeletedAndRenameMedia(ids)
                log.info({ count: ids.length, messageIds: ids }, 'messages.deleted')
            } else {
                log.warn({ groupJid: deleted.jid }, 'messages.deleted_all')
            }
        }

        for (const group of events['groups.upsert'] || []) {
            const tracked = await persistMatchingGroup(group)
            if (tracked) {
                catchup.setTrackedGroups([group.id])
                log.info({ groupJid: group.id, groupName: group.subject }, 'group.tracked')
            }
        }

        for (const event of events['groups.update'] || []) {
            if (!event?.id) continue
            const previous =
                (await getGroupMetadata(event.id)) ?? (await getParticipatingMeta(event.id))
            if (previous) {
                const merged = mergeDefined(previous, event as Partial<GroupMetadata>)
                if (event.subject && event.subject !== previous.subject) {
                    log.info(
                        {
                            groupJid: event.id,
                            from: previous.subject,
                            to: event.subject,
                        },
                        'group.renamed'
                    )
                }
                const tracked = await persistMatchingGroup(merged)
                if (tracked) catchup.setTrackedGroups([event.id])
                continue
            }
            if (event.subject && matchesGroupPattern(event.subject)) {
                await refreshGroup(sock, event.id, 'groups.update-matched')
                continue
            }
            await addSkippedGroup(event.id)
        }

        const participants = events['group-participants.update']
        if (participants) {
            const me = ownJid(sock)
            const removedSelf =
                participants.action === 'remove' &&
                Boolean(me) &&
                participants.participants.some((p) => jidNormalizedUser(p.id) === me)

            if (removedSelf) {
                await forgetGroup(participants.id, 'removed from group')
            } else {
                const cached = await getGroupMetadata(participants.id)
                if (cached) {
                    const metadata = await refreshGroup(sock, participants.id, 'participants.update')
                    if (metadata) {
                        log.debug(
                            {
                                groupJid: participants.id,
                                groupName: metadata.subject,
                                action: participants.action,
                                participants: participants.participants.length,
                            },
                            'group.participants_updated'
                        )
                    }
                }
            }
        }

        for (const jid of events['chats.delete'] || []) {
            if (isJidGroup(jid)) {
                await forgetGroup(jid, 'chats.delete')
            }
        }

        if (events['messaging-history.status']) {
            catchup.noteHistoryStatus(
                events['messaging-history.status'].syncType,
                events['messaging-history.status'].status
            )
        }
    }

    sock.ev.process(async (events) => {
        if (events['creds.update']) {
            await saveCreds()
        }
        if (events['connection.update']) {
            handleConnectionUpdate(events['connection.update'])
        }
        if (hasIngestWork(events)) {
            void runIngest(() => ingestEvents(events))
        }
    })
}

;(async () => {
    try {
        log.info(
            {
                pattern: config.groupPatternSource,
                logLevel: config.logLevel,
                skipMediaDownload: config.skipMediaDownload,
            },
            'agent.starting'
        )
        await initDb()
        await loadFilenameFormatSettings()
        startApi()
        await connectToWhatsApp()
    } catch (err) {
        log.error({ err }, 'agent.start_failed')
        process.exit(1)
    }
})()
