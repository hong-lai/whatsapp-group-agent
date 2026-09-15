import { hktStamp } from '../hkt.js'
import { groupMatchesPattern, matchingGroupJids } from './groups.js'
import { pool } from './pool.js'
import { likeContainsPattern } from './sql.js'

export type DailySiteReportDateField = 'report' | 'created' | 'message'

export type DailySiteReportSortBy =
    | 'reportDate'
    | 'createdDate'
    | 'createdAt'
    | 'messageDate'
    | 'po'
    | 'ref'
    | 'contractor'
    | 'project'
    | 'groupName'
    | 'rss'
    | 'workers'
    | 'numWorkers'
    | 'workScopes'
    | 'trench'
    | 'coring'
    | 'cable'
    | 'conduit'
    | 'trialPit'
    | 'remarks'
    | 'status'
    | 'flags'
    | 'updatedAt'

export type DailySiteReportSortDir = 'asc' | 'desc'

export type DailySiteReportIssueCode = 'missing_fields' | 'date_mismatch' | 'workers_over'

export type DailySiteReportIssue = {
    code: DailySiteReportIssueCode
    label: string
}

export type DailySiteReportCursor = {
    sortBy: DailySiteReportSortBy
    sortDir: DailySiteReportSortDir
    sortValue: string | number | null
    id: number
}

const DAILY_SITE_REPORT_SORT_SPECS: Record<
    DailySiteReportSortBy,
    { sql: string; type: 'text' | 'number' | 'date' | 'timestamptz' }
> = {
    reportDate: { sql: 'r.report_date', type: 'date' },
    createdDate: {
        sql: `(r.created_at AT TIME ZONE 'Asia/Hong_Kong')::date`,
        type: 'date',
    },
    createdAt: { sql: 'r.created_at', type: 'timestamptz' },
    messageDate: {
        sql: `(m.timestamp AT TIME ZONE 'Asia/Hong_Kong')::date`,
        type: 'date',
    },
    po: { sql: 'r.po_number', type: 'text' },
    ref: { sql: `array_to_string(r.ref_numbers, '、')`, type: 'text' },
    contractor: { sql: 'r.contractor', type: 'text' },
    project: { sql: 'r.project_name', type: 'text' },
    groupName: { sql: 'g.name', type: 'text' },
    rss: { sql: 'r.rss', type: 'text' },
    workers: { sql: `array_to_string(r.workers, '、')`, type: 'text' },
    numWorkers: { sql: 'r.num_workers', type: 'number' },
    workScopes: { sql: `array_to_string(r.work_scopes, '、')`, type: 'text' },
    trench: { sql: 'r.trench_length', type: 'number' },
    coring: { sql: 'r.coring_length', type: 'number' },
    cable: { sql: 'r.cable_pulling_length', type: 'number' },
    conduit: { sql: 'r.conduit_laying_length', type: 'number' },
    trialPit: { sql: 'r.trial_pit_count', type: 'number' },
    remarks: { sql: 'r.remarks', type: 'text' },
    status: {
        sql: `(CASE WHEN COALESCE(r.valid_num_workers, TRUE) THEN 1 ELSE 0 END)`,
        type: 'number',
    },
    flags: {
        sql: `(CASE WHEN COALESCE(m.is_deleted, FALSE) THEN 2 WHEN COALESCE(m.is_edited, FALSE) THEN 1 ELSE 0 END)`,
        type: 'number',
    },
    updatedAt: { sql: 'r.updated_at', type: 'timestamptz' },
}

function dailySiteReportDateExpr(dateField: DailySiteReportDateField): string {
    if (dateField === 'created') {
        return `(r.created_at AT TIME ZONE 'Asia/Hong_Kong')::date`
    }
    if (dateField === 'message') {
        return `(m.timestamp AT TIME ZONE 'Asia/Hong_Kong')::date`
    }
    return 'r.report_date'
}

function dailySiteReportDateFilterSql(dateField: DailySiteReportDateField): string {
    const dateExpr = dailySiteReportDateExpr(dateField)
    return `${dateExpr} >= $1::date AND ${dateExpr} <= $2::date`
}

function dailySiteReportNeedsMessagesJoin(dateField: DailySiteReportDateField): boolean {
    return dateField === 'message'
}

export function defaultDailySiteReportSort(
    dateField: DailySiteReportDateField
): { sortBy: DailySiteReportSortBy; sortDir: DailySiteReportSortDir } {
    if (dateField === 'created') return { sortBy: 'createdAt', sortDir: 'desc' }
    if (dateField === 'message') return { sortBy: 'messageDate', sortDir: 'desc' }
    return { sortBy: 'reportDate', sortDir: 'desc' }
}

export function isDailySiteReportSortBy(value: unknown): value is DailySiteReportSortBy {
    return typeof value === 'string' && value in DAILY_SITE_REPORT_SORT_SPECS
}

function dailySiteReportSortValue(
    row: DailySiteReportRow,
    sortBy: DailySiteReportSortBy
): string | number | null {
    switch (sortBy) {
        case 'reportDate':
            return row.report_date
        case 'createdDate':
            return hktDateFromDate(row.created_at)
        case 'createdAt':
            return row.created_at.toISOString()
        case 'messageDate':
            return row.message_timestamp == null
                ? null
                : hktStamp(Number(row.message_timestamp)).date
        case 'po':
            return row.po_number
        case 'ref':
            return row.ref_numbers.length ? row.ref_numbers.join('、') : null
        case 'contractor':
            return row.contractor
        case 'project':
            return row.project_name
        case 'groupName':
            return row.group_name
        case 'rss':
            return row.rss
        case 'workers':
            return row.workers.length ? row.workers.join('、') : null
        case 'numWorkers':
            return row.num_workers
        case 'workScopes':
            return row.work_scopes.length ? row.work_scopes.join('、') : null
        case 'trench':
            return row.trench_length
        case 'coring':
            return row.coring_length
        case 'cable':
            return row.cable_pulling_length
        case 'conduit':
            return row.conduit_laying_length
        case 'trialPit':
            return row.trial_pit_count
        case 'remarks':
            return row.remarks
        case 'status':
            return row.valid_num_workers === false ? 0 : 1
        case 'flags':
            if (row.message_is_deleted) return 2
            if (row.message_is_edited) return 1
            return 0
        case 'updatedAt':
            return row.updated_at.toISOString()
    }
}

function dailySiteReportCursorSql(
    sortBy: DailySiteReportSortBy,
    sortDir: DailySiteReportSortDir,
    sortValueParam: number,
    idParam: number,
    sortValue: string | number | null
): string {
    const { sql } = DAILY_SITE_REPORT_SORT_SPECS[sortBy]
    const idCmp = sortDir === 'asc' ? '>' : '<'
    const valueCmp = sortDir === 'asc' ? '>' : '<'

    if (sortValue === null) {
        return ` AND (${sql}) IS NULL AND r.id ${idCmp} $${idParam}`
    }

    return ` AND (
        ((${sql}) IS NOT NULL AND (
            (${sql}) ${valueCmp} $${sortValueParam}
            OR ((${sql}) IS NOT DISTINCT FROM $${sortValueParam} AND r.id ${idCmp} $${idParam})
        ))
        OR ((${sql}) IS NULL)
    )`
}

export type DailySiteReport = {
    id: number
    messageId: string
    groupJid: string
    groupName: string
    reportDate: string | null
    createdDate: string
    poNumber: string | null
    refNumbers: string[]
    contractor: string | null
    projectName: string | null
    rss: string | null
    workers: string[]
    numWorkers: number | null
    actualNumWorkers: number | null
    validNumWorkers: boolean | null
    workScopes: string[]
    trenchLength: number
    coringLength: number
    cablePullingLength: number
    conduitLayingLength: number
    trialPitCount: number
    remarks: string | null
    sourceText: string | null
    messageTimestamp: number | null
    messageDate: string | null
    messageIsEdited: boolean
    messageIsDeleted: boolean
    createdAt: string
    updatedAt: string
    issues: DailySiteReportIssue[]
    isValid: boolean
}

const DAILY_SITE_REPORT_ISSUE_LABELS: Record<DailySiteReportIssueCode, string> = {
    missing_fields: '資料缺失',
    date_mismatch: '日期與訊息不符',
    workers_over: '開工人數超出',
}

function hktDateFromDate(value: Date): string {
    return hktStamp(Math.floor(value.getTime() / 1000)).date
}

function computeDailySiteReportIssues(input: {
    reportDate: string | null
    poNumber: string | null
    refNumbers: string[]
    contractor: string | null
    projectName: string | null
    rss: string | null
    workers: string[]
    numWorkers: number | null
    workScopes: string[]
    messageDate: string | null
}): DailySiteReportIssue[] {
    const issues: DailySiteReportIssueCode[] = []
    const missing =
        !input.reportDate?.trim() ||
        !input.poNumber?.trim() ||
        !input.contractor?.trim() ||
        !input.projectName?.trim() ||
        !input.rss?.trim() ||
        input.refNumbers.length === 0 ||
        input.workers.length === 0 ||
        input.workScopes.length === 0 ||
        input.numWorkers == null

    if (missing) issues.push('missing_fields')
    if (
        input.reportDate &&
        input.messageDate &&
        input.reportDate !== input.messageDate
    ) {
        issues.push('date_mismatch')
    }
    if (input.numWorkers != null && input.numWorkers > input.workers.length + 1) {
        issues.push('workers_over')
    }

    return issues.map((code) => ({ code, label: DAILY_SITE_REPORT_ISSUE_LABELS[code] }))
}

type DailySiteReportRow = {
    // BIGSERIAL comes back from node-pg as string
    id: number | string
    message_id: string
    group_jid: string
    group_name: string
    report_date: string | null
    po_number: string | null
    ref_numbers: string[]
    contractor: string | null
    project_name: string | null
    rss: string | null
    workers: string[]
    num_workers: number | null
    actual_num_workers: number | null
    valid_num_workers: boolean | null
    work_scopes: string[]
    trench_length: number
    coring_length: number
    cable_pulling_length: number
    conduit_laying_length: number
    trial_pit_count: number
    remarks: string | null
    source_text: string | null
    created_at: Date
    updated_at: Date
    message_timestamp: string | null
    message_is_edited: boolean
    message_is_deleted: boolean
}

function coerceDailySiteReportId(value: number | string): number {
    const id = typeof value === 'number' ? value : Number(value)
    if (!Number.isSafeInteger(id) || id < 1) {
        throw new Error(`Invalid daily site report id: ${value}`)
    }
    return id
}

function mapDailySiteReportRow(row: DailySiteReportRow): DailySiteReport {
    const messageTimestamp =
        row.message_timestamp == null ? null : Number(row.message_timestamp)
    const messageDate =
        messageTimestamp == null ? null : hktStamp(messageTimestamp).date
    const issues = computeDailySiteReportIssues({
        reportDate: row.report_date,
        poNumber: row.po_number,
        refNumbers: row.ref_numbers ?? [],
        contractor: row.contractor,
        projectName: row.project_name,
        rss: row.rss,
        workers: row.workers ?? [],
        numWorkers: row.num_workers,
        workScopes: row.work_scopes ?? [],
        messageDate,
    })

    return {
        id: coerceDailySiteReportId(row.id),
        messageId: row.message_id,
        groupJid: row.group_jid,
        groupName: row.group_name,
        reportDate: row.report_date,
        createdDate: hktDateFromDate(row.created_at),
        poNumber: row.po_number,
        refNumbers: row.ref_numbers ?? [],
        contractor: row.contractor,
        projectName: row.project_name,
        rss: row.rss,
        workers: row.workers ?? [],
        numWorkers: row.num_workers,
        actualNumWorkers: row.actual_num_workers,
        validNumWorkers: row.valid_num_workers,
        workScopes: row.work_scopes ?? [],
        trenchLength: row.trench_length,
        coringLength: row.coring_length,
        cablePullingLength: row.cable_pulling_length,
        conduitLayingLength: row.conduit_laying_length,
        trialPitCount: row.trial_pit_count,
        remarks: row.remarks,
        sourceText: row.source_text,
        messageTimestamp,
        messageDate,
        messageIsEdited: row.message_is_edited,
        messageIsDeleted: row.message_is_deleted,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        issues,
        isValid: issues.length === 0,
    }
}

const DAILY_SITE_REPORT_SELECT = `
            r.id,
            r.message_id,
            r.group_jid,
            g.name AS group_name,
            r.report_date::text,
            r.po_number,
            r.ref_numbers,
            r.contractor,
            r.project_name,
            r.rss,
            r.workers,
            r.num_workers,
            r.actual_num_workers,
            r.valid_num_workers,
            r.work_scopes,
            r.trench_length,
            r.coring_length,
            r.cable_pulling_length,
            r.conduit_laying_length,
            r.trial_pit_count,
            r.remarks,
            r.source_text,
            r.created_at,
            r.updated_at,
            EXTRACT(EPOCH FROM m.timestamp)::bigint AS message_timestamp,
            COALESCE(m.is_edited, FALSE) AS message_is_edited,
            COALESCE(m.is_deleted, FALSE) AS message_is_deleted`

function dailySiteReportSearchSql(query: string | undefined, paramIndex: number): {
    sql: string
    params: string[]
} {
    if (!query?.trim()) return { sql: '', params: [] }
    const pattern = likeContainsPattern(query.trim())
    return {
        sql: ` AND (
            r.po_number ILIKE $${paramIndex}
            OR r.contractor ILIKE $${paramIndex}
            OR r.project_name ILIKE $${paramIndex}
            OR r.rss ILIKE $${paramIndex}
            OR EXISTS (
                SELECT 1 FROM unnest(r.ref_numbers) AS ref_value
                WHERE ref_value ILIKE $${paramIndex}
            )
            OR EXISTS (
                SELECT 1 FROM unnest(r.workers) AS worker_value
                WHERE worker_value ILIKE $${paramIndex}
            )
        )`,
        params: [pattern],
    }
}

async function dailySiteReportGroupFilter(groupJid?: string): Promise<string[]> {
    if (groupJid) {
        if (!(await groupMatchesPattern(groupJid))) return []
        return [groupJid]
    }
    return matchingGroupJids()
}

export async function listDailySiteReports(options: {
    fromDate: string
    toDate: string
    dateField?: DailySiteReportDateField
    groupJid?: string
    query?: string
    sortBy?: DailySiteReportSortBy
    sortDir?: DailySiteReportSortDir
    limit: number
    cursor?: DailySiteReportCursor
}): Promise<{ reports: DailySiteReport[]; nextCursor: DailySiteReportCursor | null; total: number }> {
    const groupJids = await dailySiteReportGroupFilter(options.groupJid)
    if (groupJids.length === 0) {
        return { reports: [], nextCursor: null, total: 0 }
    }

    const dateField = options.dateField ?? 'report'
    const defaults = defaultDailySiteReportSort(dateField)
    const sortBy = options.sortBy ?? defaults.sortBy
    const sortDir = options.sortDir ?? defaults.sortDir
    const sortSpec = DAILY_SITE_REPORT_SORT_SPECS[sortBy]
    const dateFilterSql = dailySiteReportDateFilterSql(dateField)
    const orderSql = `${sortSpec.sql} ${sortDir.toUpperCase()} NULLS LAST, r.id ${sortDir.toUpperCase()}`
    const countJoinSql = dailySiteReportNeedsMessagesJoin(dateField)
        ? `LEFT JOIN messages m ON m.message_id = r.message_id`
        : ''

    const search = dailySiteReportSearchSql(options.query, 4)
    const cursor = options.cursor
    let cursorSql = ''
    const baseParams: Array<string | number | string[] | null> = [
        options.fromDate,
        options.toDate,
        groupJids,
        ...search.params,
    ]

    const params = [...baseParams]
    if (cursor) {
        if (cursor.sortBy !== sortBy || cursor.sortDir !== sortDir) {
            throw new Error('Invalid cursor')
        }
        const sortValueParam = params.length + 1
        const idParam = params.length + 2
        cursorSql = dailySiteReportCursorSql(
            sortBy,
            sortDir,
            sortValueParam,
            idParam,
            cursor.sortValue
        )
        params.push(cursor.sortValue, cursor.id)
    }

    const limitParam = params.length + 1
    const reportSelect = DAILY_SITE_REPORT_SELECT
    const whereSql = `r.is_deleted = FALSE
           AND ${dateFilterSql}
           AND r.group_jid = ANY($3::text[])
           ${search.sql}`

    const [countResult, result] = await Promise.all([
        pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
             FROM daily_site_reports r
             ${countJoinSql}
             WHERE ${whereSql}`,
            baseParams
        ),
        pool.query<DailySiteReportRow>(
            `SELECT
                ${reportSelect}
             FROM daily_site_reports r
             JOIN groups g ON g.jid = r.group_jid
             LEFT JOIN messages m ON m.message_id = r.message_id
             WHERE ${whereSql}
               ${cursorSql}
             ORDER BY ${orderSql}
             LIMIT $${limitParam}`,
            [...params, options.limit + 1]
        ),
    ])

    const hasMore = result.rows.length > options.limit
    const pageRows = hasMore ? result.rows.slice(0, options.limit) : result.rows
    const last = pageRows.at(-1)

    return {
        reports: pageRows.map(mapDailySiteReportRow),
        nextCursor:
            hasMore && last
                ? {
                      sortBy,
                      sortDir,
                      sortValue: dailySiteReportSortValue(last, sortBy),
                      id: coerceDailySiteReportId(last.id),
                  }
                : null,
        total: Number(countResult.rows[0]?.count ?? 0),
    }
}

export async function getDailySiteReportByMessageId(
    messageId: string
): Promise<DailySiteReport | null> {
    const allowedJids = await matchingGroupJids()
    if (allowedJids.length === 0) return null
    const result = await pool.query<DailySiteReportRow>(
        `SELECT
            ${DAILY_SITE_REPORT_SELECT}
         FROM daily_site_reports r
         JOIN groups g ON g.jid = r.group_jid
         LEFT JOIN messages m ON m.message_id = r.message_id
         WHERE r.message_id = $1
           AND r.is_deleted = FALSE
           AND r.group_jid = ANY($2::text[])
         LIMIT 1`,
        [messageId, allowedJids]
    )
    const row = result.rows[0]
    return row ? mapDailySiteReportRow(row) : null
}

export async function listDailySiteReportsForExport(options: {
    fromDate: string
    toDate: string
    dateField?: DailySiteReportDateField
    groupJid?: string
    query?: string
    sortBy?: DailySiteReportSortBy
    sortDir?: DailySiteReportSortDir
    maxRows: number
}): Promise<DailySiteReport[]> {
    const page = await listDailySiteReports({
        ...options,
        limit: options.maxRows,
    })
    return page.reports
}

export async function listDailySiteReportMessageIds(options: {
    fromDate: string
    toDate: string
    dateField?: DailySiteReportDateField
    groupJid?: string
    query?: string
    maxRows: number
}): Promise<{ messageIds: string[]; total: number }> {
    const groupJids = await dailySiteReportGroupFilter(options.groupJid)
    if (groupJids.length === 0) {
        return { messageIds: [], total: 0 }
    }

    const dateField = options.dateField ?? 'report'
    const dateFilterSql = dailySiteReportDateFilterSql(dateField)
    const messagesJoinSql = dailySiteReportNeedsMessagesJoin(dateField)
        ? `LEFT JOIN messages m ON m.message_id = r.message_id`
        : ''
    const search = dailySiteReportSearchSql(options.query, 4)
    const params: Array<string | number | string[]> = [
        options.fromDate,
        options.toDate,
        groupJids,
        ...search.params,
    ]
    const whereSql = `r.is_deleted = FALSE
           AND ${dateFilterSql}
           AND r.group_jid = ANY($3::text[])
           ${search.sql}`

    const [countResult, idResult] = await Promise.all([
        pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
             FROM daily_site_reports r
             ${messagesJoinSql}
             WHERE ${whereSql}`,
            params
        ),
        pool.query<{ message_id: string }>(
            `SELECT r.message_id
             FROM daily_site_reports r
             ${messagesJoinSql}
             WHERE ${whereSql}
             ORDER BY r.id ASC
             LIMIT $${params.length + 1}`,
            [...params, options.maxRows]
        ),
    ])

    return {
        messageIds: idResult.rows.map((row) => row.message_id),
        total: Number(countResult.rows[0]?.count ?? 0),
    }
}

export type DailySiteReportMetricsPoint = {
    date: string
    trenchLength: number
    coringLength: number
    cablePullingLength: number
    conduitLayingLength: number
    trialPitCount: number
    reportCount: number
}

export async function listDailySiteReportMetricsSeries(options: {
    fromDate: string
    toDate: string
    dateField?: DailySiteReportDateField
    groupJid?: string
    query?: string
}): Promise<DailySiteReportMetricsPoint[]> {
    const groupJids = await dailySiteReportGroupFilter(options.groupJid)
    if (groupJids.length === 0) return []

    const dateField = options.dateField ?? 'report'
    const dateExpr = dailySiteReportDateExpr(dateField)
    const dateFilterSql = dailySiteReportDateFilterSql(dateField)
    const messagesJoinSql = dailySiteReportNeedsMessagesJoin(dateField)
        ? `LEFT JOIN messages m ON m.message_id = r.message_id`
        : ''
    const search = dailySiteReportSearchSql(options.query, 4)
    const params: Array<string | string[]> = [
        options.fromDate,
        options.toDate,
        groupJids,
        ...search.params,
    ]
    const whereSql = `r.is_deleted = FALSE
           AND ${dateFilterSql}
           AND r.group_jid = ANY($3::text[])
           AND ${dateExpr} IS NOT NULL
           ${search.sql}`

    const result = await pool.query<{
        day: Date | string
        trench_length: string
        coring_length: string
        cable_pulling_length: string
        conduit_laying_length: string
        trial_pit_count: string
        report_count: string
    }>(
        `SELECT
            ${dateExpr} AS day,
            COALESCE(SUM(r.trench_length), 0)::text AS trench_length,
            COALESCE(SUM(r.coring_length), 0)::text AS coring_length,
            COALESCE(SUM(r.cable_pulling_length), 0)::text AS cable_pulling_length,
            COALESCE(SUM(r.conduit_laying_length), 0)::text AS conduit_laying_length,
            COALESCE(SUM(r.trial_pit_count), 0)::text AS trial_pit_count,
            COUNT(*)::text AS report_count
         FROM daily_site_reports r
         ${messagesJoinSql}
         WHERE ${whereSql}
         GROUP BY ${dateExpr}
         ORDER BY ${dateExpr} ASC`,
        params
    )

    return result.rows.map((row) => {
        const day =
            row.day instanceof Date
                ? row.day.toISOString().slice(0, 10)
                : String(row.day).slice(0, 10)
        return {
            date: day,
            trenchLength: Number(row.trench_length) || 0,
            coringLength: Number(row.coring_length) || 0,
            cablePullingLength: Number(row.cable_pulling_length) || 0,
            conduitLayingLength: Number(row.conduit_laying_length) || 0,
            trialPitCount: Number(row.trial_pit_count) || 0,
            reportCount: Number(row.report_count) || 0,
        }
    })
}

export async function deleteDailySiteReport(id: number): Promise<{
    id: number
    messageId: string
    groupJid: string
    reportDate: string | null
    poNumber: string | null
    contractor: string | null
} | null> {
    const result = await pool.query<{
        id: number
        message_id: string
        group_jid: string
        report_date: string | null
        po_number: string | null
        contractor: string | null
    }>(
        `DELETE FROM daily_site_reports
         WHERE id = $1
         RETURNING id, message_id, group_jid, report_date::text, po_number, contractor`,
        [id]
    )
    const row = result.rows[0]
    if (!row) return null
    return {
        id: row.id,
        messageId: row.message_id,
        groupJid: row.group_jid,
        reportDate: row.report_date,
        poNumber: row.po_number,
        contractor: row.contractor,
    }
}
