import { createRedisSubscriber, redis } from '../redis.js'
import { log } from '../log.js'

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

export function subscribeWorkflowStatus(onMessage: (message: string) => void): void {
    const subscriber = createRedisSubscriber()
    subscriber.on('error', (error) => {
        log.warn({ err: String(error) }, 'workflow_status.redis_subscriber_error')
    })
    void subscriber.subscribe(WORKFLOW_STATUS_CHANNEL).catch((error: unknown) => {
        log.warn({ err: String(error) }, 'workflow_status.redis_subscribe_failed')
    })
    subscriber.on('message', (channel, message) => {
        if (channel !== WORKFLOW_STATUS_CHANNEL) return
        onMessage(message)
    })
}
