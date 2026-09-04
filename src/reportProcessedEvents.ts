import type { Request, Response } from 'express'
import { Redis } from 'ioredis'
import { redis } from './cache.js'
import { config } from './config.js'
import { log } from './log.js'

/** Redis pub/sub channel published by the Python workflow after extract/update/delete. */
export const REPORT_PROCESSED_CHANNEL = 'report.processed'

export type ReportChangeAction = 'extracted' | 'updated' | 'deleted'

export type ReportChangePayload = {
    action: ReportChangeAction
    messageId: string
    groupJid: string | null
    poNumber: string | null
    date: string | null
    contractor: string | null
    reportId: number | null
    at: string
}

const clients = new Set<Response>()
let subscriber: Redis | null = null

function ensureSubscriber(): void {
    if (subscriber) return
    subscriber = new Redis(config.redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    })
    subscriber.on('error', (error) => {
        log.warn({ err: String(error) }, 'report_processed.redis_subscriber_error')
    })
    void subscriber.subscribe(REPORT_PROCESSED_CHANNEL).catch((error: unknown) => {
        log.warn({ err: String(error) }, 'report_processed.redis_subscribe_failed')
    })
    subscriber.on('message', (channel, message) => {
        if (channel !== REPORT_PROCESSED_CHANNEL) return
        const frame = `data: ${message}\n\n`
        for (const client of clients) {
            client.write(frame)
        }
    })
}

export async function publishReportChange(
    payload: Omit<ReportChangePayload, 'at'> & { at?: string }
): Promise<void> {
    const body: ReportChangePayload = {
        ...payload,
        at: payload.at ?? new Date().toISOString(),
    }
    try {
        await redis.publish(REPORT_PROCESSED_CHANNEL, JSON.stringify(body))
    } catch (error) {
        log.warn({ err: String(error) }, 'report_processed.publish_failed')
    }
}

export function handleReportProcessedSse(request: Request, response: Response): void {
    ensureSubscriber()

    response.status(200)
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders?.()
    response.write(': connected\n\n')

    clients.add(response)

    const heartbeat = setInterval(() => {
        response.write(': heartbeat\n\n')
    }, 15_000)

    const cleanup = () => {
        clearInterval(heartbeat)
        clients.delete(response)
    }

    request.on('close', cleanup)
    request.on('aborted', cleanup)
}
