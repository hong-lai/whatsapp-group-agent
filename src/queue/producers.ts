import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { config } from '../config.js'
import { log } from '../log.js'
import { MESSAGE_EVENTS_QUEUE, type MessageEventJob } from './types.js'

let connection: Redis | null = null
let queue: Queue<MessageEventJob> | null = null

function getConnection(): Redis {
    if (!connection) {
        connection = new Redis(config.redisUrl, {
            maxRetriesPerRequest: null,
        })
    }
    return connection
}

function getQueue(): Queue<MessageEventJob> {
    if (!queue) {
        queue = new Queue<MessageEventJob>(MESSAGE_EVENTS_QUEUE, {
            connection: getConnection(),
            defaultJobOptions: {
                removeOnComplete: 1000,
                removeOnFail: 5000,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
            },
        })
    }
    return queue
}

export async function enqueueMessageEvent(
    job: Omit<MessageEventJob, 'enqueuedAt'>
): Promise<boolean> {
    if (!config.workflowsEnabled) return false
    if (job.isHistory && !config.workflowsProcessHistory) return false

    const payload: MessageEventJob = {
        ...job,
        enqueuedAt: new Date().toISOString(),
    }

    // Unique job id per event revision so edits re-run and deletes are distinct.
    const jobId = `${job.event}:${job.messageId}:${Date.now()}`

    try {
        await getQueue().add(job.event, payload, { jobId })
        log.debug(
            {
                jobId,
                event: job.event,
                messageId: job.messageId,
                groupJid: job.groupJid,
                messageType: job.messageType,
            },
            'workflow.enqueued'
        )
        return true
    } catch (err) {
        log.warn(
            { err, event: job.event, messageId: job.messageId },
            'workflow.enqueue_failed'
        )
        return false
    }
}

export async function closeMessageEventQueue(): Promise<void> {
    if (queue) {
        await queue.close()
        queue = null
    }
    if (connection) {
        await connection.quit()
        connection = null
    }
}
