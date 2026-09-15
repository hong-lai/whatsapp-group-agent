import { publishWorkflowStatus } from '../events/workflowStatus.js'
import { pool } from './pool.js'

export type WorkflowRunRecord = {
    id: number
    workflowName: string
    messageId: string
    event: string
    status: string
    detail: string | null
    createdAt: string
    updatedAt: string
}

export type WorkflowDebugMessage = {
    messageId: string
    groupJid: string
    groupName: string | null
    messageType: string
    textContent: string | null
    textLength: number
    mediaPath: string | null
    isDeleted: boolean
    isEdited: boolean
    isHistory: boolean
    isForwarded: boolean
    timestamp: number | null
}

export type WorkflowDebugSnapshot = {
    message: WorkflowDebugMessage
    runs: WorkflowRunRecord[]
    reportId: number | null
}

export async function getWorkflowDebugSnapshot(
    messageId: string,
    limit = 20
): Promise<WorkflowDebugSnapshot | null> {
    const messageResult = await pool.query<{
        message_id: string
        group_jid: string
        group_name: string | null
        message_type: string
        text_content: string | null
        media_path: string | null
        is_deleted: boolean
        is_edited: boolean
        is_history: boolean
        is_forwarded: boolean
        timestamp: string | null
    }>(
        `SELECT
            m.message_id,
            m.group_jid,
            g.name AS group_name,
            m.message_type,
            m.text_content,
            m.media_path,
            m.is_deleted,
            m.is_edited,
            m.is_history,
            m.is_forwarded,
            EXTRACT(EPOCH FROM m.timestamp)::bigint::text AS timestamp
         FROM messages m
         LEFT JOIN groups g ON g.jid = m.group_jid
         WHERE m.message_id = $1`,
        [messageId]
    )
    const messageRow = messageResult.rows[0]
    if (!messageRow) return null

    const [runsResult, reportResult] = await Promise.all([
        pool.query<{
            id: number
            workflow_name: string
            message_id: string
            event: string
            status: string
            detail: string | null
            created_at: Date
            updated_at: Date
        }>(
            `SELECT id, workflow_name, message_id, event, status, detail, created_at, updated_at
             FROM workflow_runs
             WHERE message_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2`,
            [messageId, Math.min(Math.max(limit, 1), 100)]
        ),
        pool.query<{ id: number }>(
            `SELECT id FROM daily_site_reports WHERE message_id = $1 AND is_deleted = FALSE LIMIT 1`,
            [messageId]
        ),
    ])

    const text = messageRow.text_content ?? ''
    return {
        message: {
            messageId: messageRow.message_id,
            groupJid: messageRow.group_jid,
            groupName: messageRow.group_name,
            messageType: messageRow.message_type,
            textContent: messageRow.text_content,
            textLength: text.trim().length,
            mediaPath: messageRow.media_path,
            isDeleted: messageRow.is_deleted,
            isEdited: messageRow.is_edited,
            isHistory: messageRow.is_history,
            isForwarded: messageRow.is_forwarded,
            timestamp: messageRow.timestamp == null ? null : Number(messageRow.timestamp),
        },
        runs: runsResult.rows.map((row) => ({
            id: row.id,
            workflowName: row.workflow_name,
            messageId: row.message_id,
            event: row.event,
            status: row.status,
            detail: row.detail,
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
        })),
        reportId: reportResult.rows[0]?.id ?? null,
    }
}

export async function getMessageForWorkflowEnqueue(messageId: string): Promise<{
    messageId: string
    groupJid: string
    messageType: string
    mediaPath: string | null
    isEdited: boolean
} | null> {
    const rows = await getMessagesForWorkflowEnqueue([messageId])
    return rows[0] ?? null
}

export async function getMessagesForWorkflowEnqueue(messageIds: string[]): Promise<
    Array<{
        messageId: string
        groupJid: string
        messageType: string
        mediaPath: string | null
        isEdited: boolean
    }>
> {
    if (messageIds.length === 0) return []
    const result = await pool.query<{
        message_id: string
        group_jid: string
        message_type: string
        media_path: string | null
        is_edited: boolean
    }>(
        `SELECT message_id, group_jid, message_type, media_path, is_edited
         FROM messages
         WHERE message_id = ANY($1::text[])`,
        [messageIds]
    )
    const byId = new Map(
        result.rows.map((row) => [
            row.message_id,
            {
                messageId: row.message_id,
                groupJid: row.group_jid,
                messageType: row.message_type,
                mediaPath: row.media_path,
                isEdited: Boolean(row.is_edited),
            },
        ])
    )
    return messageIds
        .map((id) => byId.get(id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
}

/** Statuses that mean a workflow job is still outstanding for a message. */
export const WORKFLOW_IN_PROGRESS_STATUSES = new Set(['queued', 'running', 'retrying'])

export type LatestWorkflowRunStatus = {
    workflowName: string
    status: string
    detail: string | null
    event: string
}

export async function recordWorkflowRun(params: {
    workflowName: string
    messageId: string
    event: string
    status: string
    detail?: string | null
    groupJid?: string | null
}): Promise<void> {
    await pool.query(
        `INSERT INTO workflow_runs (workflow_name, message_id, event, status, detail)
         VALUES ($1, $2, $3, $4, $5)`,
        [
            params.workflowName,
            params.messageId,
            params.event,
            params.status,
            params.detail ?? null,
        ]
    )
    let groupJid = params.groupJid ?? null
    if (groupJid == null) {
        const groupResult = await pool.query<{ group_jid: string | null }>(
            `SELECT group_jid FROM messages WHERE message_id = $1`,
            [params.messageId]
        )
        groupJid = groupResult.rows[0]?.group_jid ?? null
    }
    await publishWorkflowStatus({
        workflowName: params.workflowName,
        messageId: params.messageId,
        groupJid,
        event: params.event,
        status: params.status,
        detail: params.detail ?? null,
    })
}

export async function getLatestWorkflowRunStatuses(
    messageId: string,
    workflowNames?: string[]
): Promise<LatestWorkflowRunStatus[]> {
    const result = await pool.query<{
        workflow_name: string
        status: string
        detail: string | null
        event: string
    }>(
        `SELECT DISTINCT ON (workflow_name)
            workflow_name,
            status,
            detail,
            event
         FROM workflow_runs
         WHERE message_id = $1
           AND ($2::text[] IS NULL OR workflow_name = ANY($2::text[]))
         ORDER BY workflow_name, created_at DESC, id DESC`,
        [messageId, workflowNames?.length ? workflowNames : null]
    )
    return result.rows.map((row) => ({
        workflowName: row.workflow_name,
        status: row.status,
        detail: row.detail,
        event: row.event,
    }))
}

export async function findInProgressWorkflows(
    messageId: string,
    workflowNames: string[]
): Promise<LatestWorkflowRunStatus[]> {
    if (workflowNames.length === 0) return []
    const latest = await getLatestWorkflowRunStatuses(messageId, workflowNames)
    return latest.filter((row) => WORKFLOW_IN_PROGRESS_STATUSES.has(row.status))
}
