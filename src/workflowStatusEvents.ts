import type { Request, Response } from 'express'
import { Redis } from 'ioredis'
import { redis } from './cache.js'
import { config } from './config.js'
import { log } from './log.js'

/** Redis pub/sub channel published whenever a workflow_runs row is written. */
export const WORKFLOW_STATUS_CHANNEL = 'workflow.status'

export type WorkflowStatusPayload = {
    workflowName: string
    messageId: string
    groupJid: string | null
    event: string
    status: string
    detail: string | null
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
        log.warn({ err: String(error) }, 'workflow_status.redis_subscriber_error')
    })
    void subscriber.subscribe(WORKFLOW_STATUS_CHANNEL).catch((error: unknown) => {
        log.warn({ err: String(error) }, 'workflow_status.redis_subscribe_failed')
    })
    subscriber.on('message', (channel, message) => {
        if (channel !== WORKFLOW_STATUS_CHANNEL) return
        const frame = `data: ${message}\n\n`
        for (const client of clients) {
            client.write(frame)
        }
    })
}

export async function publishWorkflowStatus(
    payload: Omit<WorkflowStatusPayload, 'at'> & { at?: string }
): Promise<void> {
    const body: WorkflowStatusPayload = {
        ...payload,
        at: payload.at ?? new Date().toISOString(),
    }
    try {
        await redis.publish(WORKFLOW_STATUS_CHANNEL, JSON.stringify(body))
    } catch (error) {
        log.warn({ err: String(error) }, 'workflow_status.publish_failed')
    }
}

export function handleWorkflowStatusSse(request: Request, response: Response): void {
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
