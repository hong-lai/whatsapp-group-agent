import { createRedisSubscriber, redis } from '../redis.js'
import { log } from '../log.js'

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

const listeners = new Set<(payload: ReportChangePayload) => void>()
const rawListeners = new Set<(message: string) => void>()
let subscribed = false

export function parseReportChangePayload(message: string): ReportChangePayload | null {
    try {
        const parsed = JSON.parse(message) as Partial<ReportChangePayload>
        if (
            parsed.action !== 'extracted' &&
            parsed.action !== 'updated' &&
            parsed.action !== 'deleted'
        ) {
            return null
        }
        if (typeof parsed.messageId !== 'string' || !parsed.messageId) return null
        return {
            action: parsed.action,
            messageId: parsed.messageId,
            groupJid: typeof parsed.groupJid === 'string' ? parsed.groupJid : null,
            poNumber: typeof parsed.poNumber === 'string' ? parsed.poNumber : null,
            date: typeof parsed.date === 'string' ? parsed.date : null,
            contractor: typeof parsed.contractor === 'string' ? parsed.contractor : null,
            reportId:
                typeof parsed.reportId === 'number' && Number.isFinite(parsed.reportId)
                    ? parsed.reportId
                    : null,
            at: typeof parsed.at === 'string' ? parsed.at : new Date().toISOString(),
        }
    } catch {
        return null
    }
}

function fanOutPayload(message: string): void {
    const payload = parseReportChangePayload(message)
    if (!payload) return
    for (const listener of listeners) {
        try {
            listener(payload)
        } catch (error) {
            log.warn({ err: String(error) }, 'report_processed.listener_error')
        }
    }
}

function ensureSubscriber(): void {
    if (subscribed) return
    subscribed = true
    const subscriber = createRedisSubscriber()
    subscriber.on('error', (error) => {
        log.warn({ err: String(error) }, 'report_processed.redis_subscriber_error')
    })
    void subscriber.subscribe(REPORT_PROCESSED_CHANNEL).catch((error: unknown) => {
        log.warn({ err: String(error) }, 'report_processed.redis_subscribe_failed')
    })
    subscriber.on('message', (channel, message) => {
        if (channel !== REPORT_PROCESSED_CHANNEL) return
        for (const listener of rawListeners) listener(message)
        fanOutPayload(message)
    })
}

export function subscribeReportProcessed(onMessage: (message: string) => void): void {
    rawListeners.add(onMessage)
    ensureSubscriber()
}

/** Register a listener for report create/update/delete events. Starts Redis subscribe. */
export function onReportChange(listener: (payload: ReportChangePayload) => void): () => void {
    listeners.add(listener)
    ensureSubscriber()
    return () => {
        listeners.delete(listener)
    }
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
