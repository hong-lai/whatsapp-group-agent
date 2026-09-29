import { Queue, type Job } from 'bullmq'
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
                // High so site-report jobs survive worker restarts while the LLM is down;
                // the Python worker also retries LLM outages in-process until success.
                attempts: 100,
                backoff: { type: 'exponential', delay: 10_000 },
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

export type WorkflowBacklogState = 'active' | 'waiting' | 'prioritized'

export type WorkflowBacklogCounts = {
    active: number
    waiting: number
    prioritized: number
}

export type WorkflowBacklogJob = {
    id: string
    state: WorkflowBacklogState
    /** 1-based place among jobs in the same state. 1 is next. */
    position: number | null
    event: string
    messageId: string
    groupJid: string | null
    messageType: string | null
    isHistory: boolean
    /** Null means the worker should run every enabled workflow. */
    workflowNames: string[] | null
    enqueuedAt: string | null
    addedAt: string
    processedOn: string | null
    attemptsMade: number
}

export type WorkflowBacklogSnapshot = {
    counts: WorkflowBacklogCounts
    paused: boolean
    workers: number | null
    jobs: WorkflowBacklogJob[]
    /** True when a state has more jobs than this snapshot includes. */
    truncated: boolean
}

const ACTIVE_LIMIT = 100
const PRIORITIZED_LIMIT = 100

function countOf(counts: Record<string, number>, key: string): number {
    const value = counts[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function workflowNamesFromJob(data: MessageEventJob): string[] | null {
    if (!Array.isArray(data.workflowNames)) return null
    const names = [
        ...new Set(
            data.workflowNames
                .map((name) => (typeof name === 'string' ? name.trim() : ''))
                .filter(Boolean)
        ),
    ]
    return names.length > 0 ? names : null
}

function mapBacklogJob(
    job: Job<MessageEventJob>,
    state: WorkflowBacklogState,
    position: number | null
): WorkflowBacklogJob | null {
    const data = job.data
    if (!data || typeof data.messageId !== 'string' || !data.messageId) return null
    return {
        id: job.id ?? `${state}:${data.messageId}:${job.timestamp}`,
        state,
        position,
        event: typeof data.event === 'string' && data.event ? data.event : job.name,
        messageId: data.messageId,
        groupJid: data.groupJid ?? null,
        messageType: data.messageType ?? null,
        isHistory: Boolean(data.isHistory),
        workflowNames: workflowNamesFromJob(data),
        enqueuedAt: typeof data.enqueuedAt === 'string' ? data.enqueuedAt : null,
        addedAt: new Date(job.timestamp).toISOString(),
        processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
        attemptsMade: job.attemptsMade ?? 0,
    }
}

function takeJobs(
    jobs: Job<MessageEventJob>[],
    state: WorkflowBacklogState,
    withPosition: boolean
): WorkflowBacklogJob[] {
    const mapped: WorkflowBacklogJob[] = []
    jobs.forEach((job, index) => {
        const item = mapBacklogJob(job, state, withPosition ? index + 1 : null)
        if (item) mapped.push(item)
    })
    return mapped
}

/** Outstanding message-event jobs: running, waiting, and prioritized. */
export async function getMessageEventBacklog(limit = 200): Promise<WorkflowBacklogSnapshot> {
    const waitingLimit = Math.min(Math.max(Math.floor(limit) || 200, 1), 500)
    const queue = getQueue()
    const [counts, paused, active, waiting, prioritized, workers] = await Promise.all([
        queue.getJobCounts('active', 'waiting', 'prioritized'),
        queue.isPaused(),
        queue.getActive(0, ACTIVE_LIMIT - 1),
        queue.getWaiting(0, waitingLimit - 1),
        queue.getPrioritized(0, PRIORITIZED_LIMIT - 1),
        queue.getWorkersCount().catch(() => null),
    ])

    const snapshotCounts: WorkflowBacklogCounts = {
        active: countOf(counts, 'active'),
        waiting: countOf(counts, 'waiting'),
        prioritized: countOf(counts, 'prioritized'),
    }

    const activeJobs = takeJobs(active, 'active', false).sort((a, b) => {
        const aTime = a.processedOn ? Date.parse(a.processedOn) : Number.POSITIVE_INFINITY
        const bTime = b.processedOn ? Date.parse(b.processedOn) : Number.POSITIVE_INFINITY
        return aTime - bTime
    })
    const prioritizedJobs = takeJobs(prioritized, 'prioritized', true)
    const waitingJobs = takeJobs(waiting, 'waiting', true)

    return {
        counts: snapshotCounts,
        paused,
        workers: typeof workers === 'number' ? workers : null,
        jobs: [...activeJobs, ...prioritizedJobs, ...waitingJobs],
        truncated:
            snapshotCounts.active > active.length ||
            snapshotCounts.waiting > waiting.length ||
            snapshotCounts.prioritized > prioritized.length,
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
