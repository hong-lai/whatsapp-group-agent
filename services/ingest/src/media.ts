import {
    downloadMediaMessage,
    normalizeMessageContent,
    proto,
    type WAMessage,
    type WASocket,
} from '@whiskeysockets/baileys'
import logger from '@whiskeysockets/baileys/lib/Utils/logger.js'
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { basename, extname } from 'path'
import { pipeline } from 'stream/promises'
import type { Readable } from 'stream'
import {
    getMessageMediaState,
    markMessagesDeleted,
    updateMessageMediaPath,
} from '../../../packages/shared/src/db/index.js'
import {
    buildMediaFilename,
    filenameTypeForMessage,
    getFilenameFormatSettings,
    uniqueMediaPath,
} from '../../../packages/shared/src/filenameFormat.js'
import { firstAvailableName, sanitizeFilename, withDeletedSuffix } from '../../../packages/shared/src/filenames.js'
import { hktStamp } from '../../../packages/shared/src/hkt.js'
import { log } from '../../../packages/shared/src/log.js'
import { enqueueMessageEvent } from '../../../packages/shared/src/queue/index.js'
import { config } from './config.js'
import { retryBackoffMs, sleep, waitMediaDownload } from './rateLimit.js'

export const fileTypes: Record<string, string> = {
    imageMessage: 'jpeg',
    videoMessage: 'mp4',
    ptvMessage: 'mp4',
    stickerMessage: 'webp',
    documentMessage: 'pdf',
    audioMessage: 'ogg',
}

export function isAlbumMediaType(messageType: string): boolean {
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

export function originalMediaName(
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
export function contentForIngest(message: proto.IMessage | null | undefined): proto.IMessage | null | undefined {
    if (!message) return message
    if (message.imageMessage && message.associatedChildMessage) {
        const rest = { ...message, associatedChildMessage: null }
        return normalizeMessageContent(rest) || rest
    }
    return normalizeMessageContent(message) || message
}

export function isLivePhotoMotionVideo(
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

export function messageForMediaDownload(m: WAMessage): WAMessage {
    const msg = m.message
    if (!msg?.imageMessage || !msg.associatedChildMessage) return m
    return { ...m, message: { ...msg, associatedChildMessage: null } }
}
export function suffixDeletedMediaFile(currentPath: string): string | null {
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

export async function markDeletedAndRenameMedia(messageIds: string[]): Promise<void> {
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

export type MediaStoreMeta = {
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
        /ETIMEDOUT|ENETUNREACH|EAI_AGAIN|ECONNRESET|ECONNREFUSED|EPIPE|ECONNABORTED|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|socket hang up|Connection Closed|connection closed|Stream Errored|aborted|Premature close/i.test(
            error
        )
    )
}

/** Bumped on every WhatsApp disconnect so in-flight media retries stop using a dead socket. */
let mediaSocketGeneration = 0
/** Messages waiting for a successful media download (survives reconnect). */
const pendingMediaDownloads = new Map<string, { m: WAMessage; meta: MediaStoreMeta }>()
/** Prevents concurrent downloads for the same message id. */
const inFlightMediaDownloads = new Set<string>()

export function bumpMediaSocketGeneration(): void {
    mediaSocketGeneration += 1
    // Aborted retries must not block recovery on the new socket.
    inFlightMediaDownloads.clear()
}

function rememberPendingMedia(m: WAMessage, meta: MediaStoreMeta): void {
    pendingMediaDownloads.set(meta.messageId, { m, meta })
}

function forgetPendingMedia(messageId: string): void {
    pendingMediaDownloads.delete(messageId)
}

function releaseMediaInFlight(messageId: string, sockGeneration: number): void {
    if (sockGeneration === mediaSocketGeneration) {
        inFlightMediaDownloads.delete(messageId)
    }
}

async function mediaAlreadyStored(messageId: string): Promise<boolean> {
    const state = await getMessageMediaState(messageId)
    return Boolean(state?.mediaPath)
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
    const safeFolderName = sanitizeFilename(meta.groupName, meta.groupJid)
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
    firstErr: unknown,
    sockGeneration: number
): Promise<void> {
    const maxAttempts = Math.max(1, config.mediaRetryMaxAttempts)
    let err = firstErr

    const abortedByReconnect = (attempt: number): boolean => {
        if (sockGeneration === mediaSocketGeneration) return false
        log.info(
            {
                messageId: meta.messageId,
                groupJid: meta.groupJid,
                attempt,
            },
            'media.retry_aborted_reconnect'
        )
        return true
    }

    for (let failedAttempt = 1; failedAttempt < maxAttempts; failedAttempt++) {
        if (abortedByReconnect(failedAttempt)) return
        if (!isRetryableMediaError(err)) {
            forgetPendingMedia(meta.messageId)
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
        // Disconnect may have happened during backoff — re-check before touching the socket.
        if (abortedByReconnect(failedAttempt)) return
        if (await mediaAlreadyStored(meta.messageId)) {
            forgetPendingMedia(meta.messageId)
            return
        }
        try {
            await downloadMediaOnce(m, sock, fileName)
            const storedPath = await persistMediaPath(meta.messageId, fileName)
            forgetPendingMedia(meta.messageId)
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
    if (sockGeneration !== mediaSocketGeneration) return
    forgetPendingMedia(meta.messageId)
    logMediaDownloadFailure(err, meta, maxAttempts)
}

export async function storeMediaFile(
    m: WAMessage,
    sock: WASocket,
    meta: MediaStoreMeta
): Promise<string | null> {
    const fallbackExt = fileTypes[meta.messageType]
    if (!fallbackExt) return null
    if (isLivePhotoMotionVideo(m.message, contentForIngest(m.message))) return null
    if (await mediaAlreadyStored(meta.messageId)) {
        forgetPendingMedia(meta.messageId)
        return null
    }
    if (inFlightMediaDownloads.has(meta.messageId)) {
        // Refresh the WAMessage so reconnect recovery uses the latest payload.
        rememberPendingMedia(m, meta)
        return null
    }

    inFlightMediaDownloads.add(meta.messageId)
    rememberPendingMedia(m, meta)
    const sockGeneration = mediaSocketGeneration
    let handoffToRetry = false
    try {
        const fileName = await mediaDestPath(m, meta, fallbackExt)
        try {
            await downloadMediaOnce(m, sock, fileName)
            const storedPath = await persistMediaPath(meta.messageId, fileName)
            forgetPendingMedia(meta.messageId)
            enqueueMediaReady(meta, storedPath)
            return storedPath
        } catch (err) {
            const maxAttempts = Math.max(1, config.mediaRetryMaxAttempts)
            if (isRetryableMediaError(err) && maxAttempts > 1) {
                handoffToRetry = true
                void retryMediaDownload(m, sock, meta, fileName, err, sockGeneration)
                    .catch((retryErr) => {
                        log.warn(
                            {
                                err: retryErr,
                                messageId: meta.messageId,
                                groupJid: meta.groupJid,
                            },
                            'media.retry_loop_failed'
                        )
                    })
                    .finally(() => {
                        releaseMediaInFlight(meta.messageId, sockGeneration)
                    })
                return null
            }
            forgetPendingMedia(meta.messageId)
            logMediaDownloadFailure(err, meta, 1)
            return null
        }
    } finally {
        if (!handoffToRetry) releaseMediaInFlight(meta.messageId, sockGeneration)
    }
}

export async function recoverPendingMediaDownloads(sock: WASocket): Promise<void> {
    if (config.skipMediaDownload || pendingMediaDownloads.size === 0) return
    const pending = [...pendingMediaDownloads.values()]
    log.info({ count: pending.length }, 'media.recover_pending')
    for (const { m, meta } of pending) {
        if (await mediaAlreadyStored(meta.messageId)) {
            forgetPendingMedia(meta.messageId)
            continue
        }
        if (inFlightMediaDownloads.has(meta.messageId)) continue
        void storeMediaFile(m, sock, { ...meta, isHistory: true }).catch((err) => {
            log.warn(
                { err, messageId: meta.messageId, groupJid: meta.groupJid },
                'media.recover_failed'
            )
        })
    }
}
