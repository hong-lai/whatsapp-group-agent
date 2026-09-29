import { useCallback, useEffect, useRef, useState } from 'react'
import { useVisibleInterval } from './useVisibleInterval'

type WorkflowBacklogCounts = {
    active: number
    waiting: number
    prioritized: number
}

type BacklogRun = {
    workflowName: string
    label: string
    status: string
    detail: string | null
    updatedAt: string
}

type BacklogWorkflow = {
    name: string
    label: string
}

type WorkflowBacklogJob = {
    id: string
    state: 'active' | 'waiting' | 'prioritized'
    position: number | null
    event: string
    messageId: string
    groupJid: string | null
    groupName: string | null
    stored: boolean
    messageType: string | null
    preview: string | null
    sentAt: number | null
    isDeleted: boolean
    isHistory: boolean
    workflowNames: string[] | null
    enqueuedAt: string | null
    addedAt: string
    processedOn: string | null
    attemptsMade: number
    runs: BacklogRun[]
    workflows: BacklogWorkflow[]
}

type BacklogResponse = {
    workflowsEnabled: boolean
    paused: boolean
    workers: number | null
    counts: WorkflowBacklogCounts
    truncated: boolean
    jobs: WorkflowBacklogJob[]
    error?: string
}

const EVENT_LABELS: Record<string, string> = {
    'message.created': 'New message',
    'message.edited': 'Edited',
    'message.deleted': 'Deleted',
    'message.media_ready': 'Media ready',
}

const TYPE_LABELS: Record<string, string> = {
    imageMessage: 'Photo',
    videoMessage: 'Video',
    ptvMessage: 'Video',
    stickerMessage: 'Sticker',
    audioMessage: 'Audio',
    documentMessage: 'Document',
    albumMessage: 'Album',
}

function outstandingWorkflowCount(counts: WorkflowBacklogCounts): number {
    return counts.active + counts.waiting + counts.prioritized
}

function formatAge(iso: string | null): string | null {
    if (!iso) return null
    const ms = Date.now() - Date.parse(iso)
    if (!Number.isFinite(ms)) return null
    const sec = Math.max(0, Math.floor(ms / 1000))
    if (sec < 60) return `${sec}s`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m`
    const hr = Math.floor(min / 60)
    const rem = min % 60
    if (hr < 48) return rem ? `${hr}h ${rem}m` : `${hr}h`
    return `${Math.floor(hr / 24)}d`
}

function eventLabel(event: string): string {
    return EVENT_LABELS[event] ?? event
}

function typeLabel(messageType: string | null): string | null {
    if (!messageType) return null
    return TYPE_LABELS[messageType] ?? messageType
}

function statusOf(job: WorkflowBacklogJob): { label: string; tone: string } {
    const runStatus = job.runs[0]?.status
    if (runStatus === 'retrying') return { label: 'Retrying', tone: 'retrying' }
    if (job.state === 'active' || runStatus === 'running') return { label: 'Processing', tone: 'running' }
    return { label: 'Queued', tone: 'queued' }
}

function summaryText(counts: WorkflowBacklogCounts): string {
    const queued = counts.waiting + counts.prioritized
    const parts = [
        counts.active === 0 ? null : counts.active === 1 ? '1 processing' : `${counts.active} processing`,
        queued === 0 ? null : queued === 1 ? '1 queued' : `${queued} queued`,
    ].filter((part): part is string => Boolean(part))
    return parts.join(' · ')
}

function jobTitle(job: WorkflowBacklogJob): string {
    return job.groupName || (job.stored ? 'Unknown group' : 'Removed message')
}

function jobSubtitle(job: WorkflowBacklogJob): string {
    const retrying = job.runs[0]?.status === 'retrying'
    const detail = job.runs.find((run) => run.detail)?.detail
    if (retrying && detail) return detail
    const workflow = job.workflows.map((item) => item.label).join(', ')
    const rest = job.preview || typeLabel(job.messageType) || eventLabel(job.event)
    return [workflow, rest].filter(Boolean).join(' · ')
}

function startedAt(job: WorkflowBacklogJob): string | null {
    return job.state === 'active' ? job.processedOn ?? job.enqueuedAt : job.enqueuedAt ?? job.addedAt
}

export default function WorkflowBacklogView({
    active,
    liveTick,
    onOutstandingChange,
    onOpenGroup,
}: {
    active: boolean
    liveTick: number
    onOutstandingChange?: (count: number) => void
    onOpenGroup?: (groupJid: string, sentAt: number | null) => void
}) {
    const [data, setData] = useState<BacklogResponse | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const requestId = useRef(0)
    const onOutstandingRef = useRef(onOutstandingChange)
    onOutstandingRef.current = onOutstandingChange

    const load = useCallback(async () => {
        const id = ++requestId.current
        try {
            const response = await fetch('/api/workflows/backlog')
            const body = (await response.json()) as BacklogResponse
            if (id !== requestId.current) return
            if (!response.ok) throw new Error(body.error || `Could not load the queue (${response.status})`)
            setData(body)
            setError(null)
            onOutstandingRef.current?.(outstandingWorkflowCount(body.counts))
        } catch (reason) {
            if (id !== requestId.current) return
            setError(reason instanceof Error ? reason.message : 'Could not load the queue')
        } finally {
            if (id === requestId.current) setLoading(false)
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load, liveTick])

    useVisibleInterval(() => {
        void load()
    }, active ? 2000 : 8000)

    const jobs = data?.jobs ?? []

    return (
        <section className="queue-panel" aria-busy={loading && !data}>
            <header className="queue-heading">
                <h2>Queue</h2>
                {data && jobs.length > 0 && <p>{summaryText(data.counts)}</p>}
                {!data && <p>{loading ? 'Loading…' : 'Queue unavailable'}</p>}
            </header>

            {data?.paused && (
                <p className="queue-banner" role="status">
                    Queue is paused.
                </p>
            )}
            {error && (
                <p className="queue-banner is-error" role="alert">
                    <span>{error}</span>
                    <button type="button" onClick={() => void load()}>
                        Try again
                    </button>
                </p>
            )}

            {loading && !data && <p className="queue-empty">Loading…</p>}
            {data && jobs.length === 0 && !error && <p className="queue-empty">Nothing processing or queued.</p>}
            {jobs.length > 0 && (
                <ol className="queue-list">
                    {jobs.map((job) => {
                        const status = statusOf(job)
                        const age = formatAge(startedAt(job))
                        const open = job.groupJid && onOpenGroup ? () => onOpenGroup(job.groupJid as string, job.sentAt) : null
                        const body = (
                            <>
                                <span className="queue-mark" aria-hidden="true">
                                    {status.tone === 'queued' ? job.position ?? '' : <span className="queue-dot" />}
                                </span>
                                <span className="queue-copy">
                                    <strong>{jobTitle(job)}</strong>
                                    <span>{jobSubtitle(job)}</span>
                                </span>
                                {age && <time className="queue-age">{age}</time>}
                            </>
                        )
                        return (
                            <li key={job.id}>
                                {open ? (
                                    <button
                                        type="button"
                                        className={`queue-row is-${status.tone}`}
                                        onClick={open}
                                    >
                                        {body}
                                    </button>
                                ) : (
                                    <div className={`queue-row is-${status.tone}`}>{body}</div>
                                )}
                            </li>
                        )
                    })}
                </ol>
            )}
            {data?.truncated && jobs.length > 0 && <p className="queue-note">Showing the first {jobs.length}.</p>}
        </section>
    )
}
