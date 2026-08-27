import type { WAMessage } from '@whiskeysockets/baileys'
import { config } from './config.js'
import {
    getMessageMediaPath,
    listDueMediaJobs,
    markMediaJobDone,
    markMediaJobRetry,
    markMediaJobUnavailable,
    upsertMediaJob,
} from './db.js'
import { log } from './log.js'
import { retryBackoffMs } from './rateLimit.js'

export type MediaMeta = {
    messageId: string
    groupJid: string
    groupName: string
    messageType: string
    timestamp: number
    isHistory: boolean
    senderName: string
    albumIndex: number | null
}

export type MediaDownloadResult =
    | { status: 'stored'; path: string }
    | { status: 'skipped' }
    | { status: 'retry'; error: string }
    | { status: 'unavailable'; error: string }

export type MediaDownloader = (m: WAMessage, meta: MediaMeta) => Promise<MediaDownloadResult>

const POLL_MS = 5000

function isByteArray(value: unknown): value is Uint8Array {
    return typeof Buffer !== 'undefined' && (Buffer.isBuffer(value) || value instanceof Uint8Array)
}

export function serializeWaMessage(m: WAMessage): unknown {
    return JSON.parse(
        JSON.stringify(m, (_key, value) => {
            if (typeof value === 'bigint') return { $bigint: value.toString() }
            if (isByteArray(value)) return { $bytes: Buffer.from(value).toString('base64') }
            return value
        })
    )
}

export function reviveWaMessage(raw: unknown): WAMessage {
    const asString = typeof raw === 'string' ? raw : JSON.stringify(raw)
    return JSON.parse(asString, (_key, value) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (typeof value.$bytes === 'string') return Buffer.from(value.$bytes, 'base64')
            if (typeof value.$bigint === 'string') return Number(value.$bigint)
        }
        return value
    }) as WAMessage
}

export function createMediaRetry(download: MediaDownloader) {
    let stopped = false
    let draining = false
    let timer: ReturnType<typeof setTimeout> | undefined

    function schedule(delayMs = POLL_MS): void {
        if (stopped) return
        clearTimeout(timer)
        timer = setTimeout(() => {
            void drain()
        }, delayMs)
    }

    async function persistAndRetry(
        m: WAMessage,
        meta: MediaMeta,
        error: string,
        attempts = 1
    ): Promise<void> {
        if (attempts >= config.mediaRetryMaxAttempts) {
            await upsertMediaJob({
                messageId: meta.messageId,
                groupJid: meta.groupJid,
                groupName: meta.groupName,
                messageType: meta.messageType,
                timestamp: meta.timestamp,
                senderName: meta.senderName,
                albumIndex: meta.albumIndex,
                rawMessage: serializeWaMessage(m),
            })
            await markMediaJobUnavailable(meta.messageId, error)
            log.warn(
                { messageId: meta.messageId, groupJid: meta.groupJid, attempts, error },
                'media.retry_exhausted'
            )
            return
        }
        const nextRetryAt = Math.floor(
            (Date.now() + retryBackoffMs(attempts, config.mediaRetryMinMs, config.mediaRetryMaxMs)) / 1000
        )
        await upsertMediaJob({
            messageId: meta.messageId,
            groupJid: meta.groupJid,
            groupName: meta.groupName,
            messageType: meta.messageType,
            timestamp: meta.timestamp,
            senderName: meta.senderName,
            albumIndex: meta.albumIndex,
            rawMessage: serializeWaMessage(m),
        })
        await markMediaJobRetry(meta.messageId, attempts, nextRetryAt, error)
        log.info(
            { messageId: meta.messageId, groupJid: meta.groupJid, attempts, nextRetryAt },
            'media.retry_scheduled'
        )
    }

    async function handleResult(
        m: WAMessage,
        meta: MediaMeta,
        result: MediaDownloadResult,
        attempts: number
    ): Promise<void> {
        if (result.status === 'stored') {
            await markMediaJobDone(meta.messageId)
            return
        }
        if (result.status === 'skipped') {
            await markMediaJobDone(meta.messageId)
            return
        }
        if (result.status === 'unavailable') {
            await upsertMediaJob({
                messageId: meta.messageId,
                groupJid: meta.groupJid,
                groupName: meta.groupName,
                messageType: meta.messageType,
                timestamp: meta.timestamp,
                senderName: meta.senderName,
                albumIndex: meta.albumIndex,
                rawMessage: serializeWaMessage(m),
            })
            await markMediaJobUnavailable(meta.messageId, result.error)
            return
        }
        await persistAndRetry(m, meta, result.error, attempts)
    }

    async function drain(): Promise<void> {
        if (stopped || draining) return
        draining = true
        let processed = 0
        try {
            while (!stopped) {
                const jobs = await listDueMediaJobs(1)
                if (jobs.length === 0) break
                for (const job of jobs) {
                    if (stopped) return
                    processed += 1
                    const existing = await getMessageMediaPath(job.messageId)
                    if (existing) {
                        await markMediaJobDone(job.messageId)
                        continue
                    }
                    const attempts = job.attempts + 1
                    try {
                        const message = reviveWaMessage(job.rawMessage)
                        const meta: MediaMeta = {
                            messageId: job.messageId,
                            groupJid: job.groupJid,
                            groupName: job.groupName,
                            messageType: job.messageType,
                            timestamp: job.timestamp,
                            isHistory: true,
                            senderName: job.senderName,
                            albumIndex: job.albumIndex,
                        }
                        const result = await download(message, meta)
                        await handleResult(message, meta, result, attempts)
                    } catch (err) {
                        await markMediaJobRetry(
                            job.messageId,
                            attempts,
                            Math.floor(
                                (Date.now() +
                                    retryBackoffMs(
                                        attempts,
                                        config.mediaRetryMinMs,
                                        config.mediaRetryMaxMs
                                    )) /
                                    1000
                            ),
                            String(err)
                        )
                        log.warn(
                            { err, messageId: job.messageId, groupJid: job.groupJid, attempts },
                            'media.retry_failed'
                        )
                    }
                }
            }
        } catch (err) {
            log.warn({ err }, 'media.retry_drain_failed')
        } finally {
            draining = false
            schedule(processed > 0 ? 250 : POLL_MS)
        }
    }

    schedule(1000)

    return {
        async enqueue(m: WAMessage, meta: MediaMeta, result?: MediaDownloadResult): Promise<void> {
            if (result?.status === 'stored' || result?.status === 'skipped') {
                await markMediaJobDone(meta.messageId)
                return
            }
            if (result?.status === 'unavailable') {
                await upsertMediaJob({
                    messageId: meta.messageId,
                    groupJid: meta.groupJid,
                    groupName: meta.groupName,
                    messageType: meta.messageType,
                    timestamp: meta.timestamp,
                    senderName: meta.senderName,
                    albumIndex: meta.albumIndex,
                    rawMessage: serializeWaMessage(m),
                })
                await markMediaJobUnavailable(meta.messageId, result.error)
                return
            }
            if (result?.status === 'retry') {
                await persistAndRetry(m, meta, result.error, 1)
            } else {
                await upsertMediaJob({
                    messageId: meta.messageId,
                    groupJid: meta.groupJid,
                    groupName: meta.groupName,
                    messageType: meta.messageType,
                    timestamp: meta.timestamp,
                    senderName: meta.senderName,
                    albumIndex: meta.albumIndex,
                    rawMessage: serializeWaMessage(m),
                })
            }
            schedule(250)
        },
        stop() {
            stopped = true
            if (timer) clearTimeout(timer)
        },
    }
}
