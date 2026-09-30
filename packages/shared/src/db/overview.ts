import { hktStamp } from '../hkt.js'
import { matchingGroupJids } from './groups.js'
import { pool } from './pool.js'
import { getAppSetting, setAppSetting } from './settings.js'
import { resolveMentionedText } from './dashboard.js'
import { computeDailySiteReportIssues, type DailySiteReportIssue } from './reports.js'
import { DASHBOARD_HIDDEN_MESSAGE_TYPES, DASHBOARD_HIDDEN_TYPES_SQL } from './sql.js'

export type OverviewLatestSiteReport = {
    id: number
    reportDate: string | null
    poNumber: string | null
    contractor: string | null
    projectName: string | null
    rss: string | null
    numWorkers: number | null
    workScopes: string[]
    trenchLength: number
    coringLength: number
    cablePullingLength: number
    conduitLayingLength: number
    trialPitCount: number
    issues: DailySiteReportIssue[]
    isValid: boolean
}

export type OverviewDailySiteReport = {
    count: number
    issueCount: number
    errorCount: number
    latest: OverviewLatestSiteReport | null
}

export type OverviewMediaCounts = {
    conversation: number
    document: number
    image: number
    video: number
}

export type OverviewTopParticipant = {
    name: string
    messageCount: number
    share: number
}

export type OverviewGroup = {
    jid: string
    name: string
    messageCount: number
    senderCount: number
    latestTimestamp: number | null
    latestText: string | null
    media: OverviewMediaCounts
    topParticipant: OverviewTopParticipant | null
    dailySiteReport: OverviewDailySiteReport
}

export type OverviewTotals = {
    activeGroups: number
    messages: number
    reports: number
    reportsNeedingReview: number
}

export type GroupOverview = {
    totals: OverviewTotals
    groups: OverviewGroup[]
}

type ActivityRow = {
    jid: string
    name: string
    message_count: number
    sender_count: number
    conversation_count: number
    document_count: number
    image_count: number
    video_count: number
    latest_timestamp: string | null
    latest_text: string | null
}

type TopParticipantRow = {
    group_jid: string
    sender_name: string
    message_count: number
}

type ReportSliceRow = {
    id: number | string
    group_jid: string
    report_date: string | null
    po_number: string | null
    ref_numbers: string[] | null
    contractor: string | null
    project_name: string | null
    rss: string | null
    workers: string[] | null
    num_workers: number | null
    work_scopes: string[] | null
    trench_length: number | string | null
    coring_length: number | string | null
    cable_pulling_length: number | string | null
    conduit_laying_length: number | string | null
    trial_pit_count: number | string | null
    message_timestamp: string | null
}

type ErrorCountRow = {
    group_jid: string
    error_count: number
}

function asNumber(value: number | string | null | undefined, fallback = 0): number {
    if (value == null) return fallback
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

function asIntOrNull(value: number | string | null | undefined): number | null {
    if (value == null) return null
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function reportSortKey(row: ReportSliceRow): string {
    const date = row.report_date ?? ''
    const id = String(asNumber(row.id)).padStart(12, '0')
    return `${date}|${id}`
}

function sliceIssues(row: ReportSliceRow): DailySiteReportIssue[] {
    const messageTimestamp = row.message_timestamp == null ? null : Number(row.message_timestamp)
    const messageDate =
        messageTimestamp == null || !Number.isFinite(messageTimestamp)
            ? null
            : hktStamp(messageTimestamp).date
    return computeDailySiteReportIssues({
        reportDate: row.report_date,
        poNumber: row.po_number,
        refNumbers: row.ref_numbers ?? [],
        contractor: row.contractor,
        projectName: row.project_name,
        rss: row.rss,
        workers: row.workers ?? [],
        numWorkers: asIntOrNull(row.num_workers),
        workScopes: row.work_scopes ?? [],
        messageDate,
    })
}

function toLatest(row: ReportSliceRow): OverviewLatestSiteReport {
    const issues = sliceIssues(row)
    return {
        id: asNumber(row.id),
        reportDate: row.report_date,
        poNumber: row.po_number,
        contractor: row.contractor,
        projectName: row.project_name,
        rss: row.rss,
        numWorkers: asIntOrNull(row.num_workers),
        workScopes: row.work_scopes ?? [],
        trenchLength: asNumber(row.trench_length),
        coringLength: asNumber(row.coring_length),
        cablePullingLength: asNumber(row.cable_pulling_length),
        conduitLayingLength: asNumber(row.conduit_laying_length),
        trialPitCount: asNumber(row.trial_pit_count),
        issues,
        isValid: issues.length === 0,
    }
}

function activityTime(group: OverviewGroup): number {
    if (group.latestTimestamp != null) return group.latestTimestamp
    const date = group.dailySiteReport.latest?.reportDate
    if (!date) return -1
    const [year, month, day] = date.split('-').map(Number)
    if (!year || !month || !day) return -1
    return Math.floor(Date.UTC(year, month - 1, day) / 1000) - 8 * 60 * 60
}

export async function getGroupOverview(
    fromDate: string,
    toDate: string,
    fromTimestamp: number,
    toTimestamp: number
): Promise<GroupOverview> {
    const matching = await matchingGroupJids()
    const empty: GroupOverview = {
        totals: { activeGroups: 0, messages: 0, reports: 0, reportsNeedingReview: 0 },
        groups: [],
    }
    if (matching.length === 0) return empty

    const tracked = await pool.query<{ jid: string }>(
        `SELECT jid FROM groups WHERE tracked = TRUE AND jid = ANY($1::text[])`,
        [matching]
    )
    const groupJids = tracked.rows.map((row) => row.jid)
    if (groupJids.length === 0) return empty

    const hiddenTypes = [...DASHBOARD_HIDDEN_MESSAGE_TYPES]
    const [activity, reports, errors, leaders] = await Promise.all([
        pool.query<ActivityRow>(
            `SELECT
                g.jid,
                g.name,
                COUNT(m.message_id)::int AS message_count,
                COUNT(DISTINCT m.sender_jid)::int AS sender_count,
                COUNT(m.message_id) FILTER (
                    WHERE m.message_type IN ('conversation', 'extendedTextMessage')
                )::int AS conversation_count,
                COUNT(m.message_id) FILTER (
                    WHERE m.message_type = 'documentMessage'
                )::int AS document_count,
                COUNT(m.message_id) FILTER (
                    WHERE m.message_type = 'imageMessage'
                )::int AS image_count,
                COUNT(m.message_id) FILTER (
                    WHERE m.message_type IN ('videoMessage', 'ptvMessage')
                )::int AS video_count,
                EXTRACT(EPOCH FROM latest.timestamp)::bigint AS latest_timestamp,
                latest.text_content AS latest_text
             FROM groups g
             LEFT JOIN messages m
               ON m.group_jid = g.jid
              AND m.timestamp >= to_timestamp($1)
              AND m.timestamp < to_timestamp($2)
              AND ${DASHBOARD_HIDDEN_TYPES_SQL}
             LEFT JOIN LATERAL (
                SELECT timestamp,
                       CASE
                           WHEN message_type = 'albumMessage' THEN 'Album'
                           WHEN message_type IN ('contactMessage', 'contactsArrayMessage')
                               THEN COALESCE(NULLIF(text_content, ''), 'Contact')
                           WHEN message_type IN ('locationMessage', 'liveLocationMessage')
                               THEN COALESCE(NULLIF(text_content, ''), 'Location')
                           ELSE text_content
                       END AS text_content
                FROM messages
                WHERE group_jid = g.jid
                  AND timestamp >= to_timestamp($1)
                  AND timestamp < to_timestamp($2)
                  AND message_type <> ALL($4::text[])
                ORDER BY timestamp DESC, message_id DESC
                LIMIT 1
             ) latest ON TRUE
             WHERE g.jid = ANY($3::text[])
             GROUP BY g.jid, g.name, latest.timestamp, latest.text_content`,
            [fromTimestamp, toTimestamp, groupJids, hiddenTypes]
        ),
        pool.query<ReportSliceRow>(
            `SELECT
                r.id,
                r.group_jid,
                r.report_date::text AS report_date,
                r.po_number,
                r.ref_numbers,
                r.contractor,
                r.project_name,
                r.rss,
                r.workers,
                r.num_workers,
                r.work_scopes,
                r.trench_length,
                r.coring_length,
                r.cable_pulling_length,
                r.conduit_laying_length,
                r.trial_pit_count,
                EXTRACT(EPOCH FROM m.timestamp)::bigint AS message_timestamp
             FROM daily_site_reports r
             LEFT JOIN messages m ON m.message_id = r.message_id
             WHERE r.is_deleted = FALSE
               AND r.report_date >= $1::date
               AND r.report_date <= $2::date
               AND r.group_jid = ANY($3::text[])`,
            [fromDate, toDate, groupJids]
        ),
        pool.query<ErrorCountRow>(
            `SELECT m.group_jid, COUNT(*)::int AS error_count
             FROM messages m
             JOIN LATERAL (
                SELECT wr.status
                FROM workflow_runs wr
                WHERE wr.message_id = m.message_id
                  AND wr.workflow_name = 'daily_site_report'
                ORDER BY wr.created_at DESC, wr.id DESC
                LIMIT 1
             ) latest ON TRUE
             WHERE m.group_jid = ANY($1::text[])
               AND m.timestamp >= to_timestamp($2)
               AND m.timestamp < to_timestamp($3)
               AND m.message_type <> ALL($4::text[])
               AND latest.status = 'error'
             GROUP BY m.group_jid`,
            [groupJids, fromTimestamp, toTimestamp, hiddenTypes]
        ),
        pool.query<TopParticipantRow>(
            `SELECT DISTINCT ON (ranked.group_jid)
                ranked.group_jid,
                ranked.sender_name,
                ranked.message_count
             FROM (
                SELECT
                    m.group_jid,
                    COALESCE(
                        NULLIF(btrim(s.display_name), ''),
                        split_part(m.sender_jid, '@', 1)
                    ) AS sender_name,
                    COUNT(*)::int AS message_count
                FROM messages m
                LEFT JOIN senders s ON s.jid = m.sender_jid
                WHERE m.group_jid = ANY($1::text[])
                  AND m.timestamp >= to_timestamp($2)
                  AND m.timestamp < to_timestamp($3)
                  AND m.message_type <> ALL($4::text[])
                GROUP BY m.group_jid, m.sender_jid, s.display_name
             ) ranked
             ORDER BY ranked.group_jid, ranked.message_count DESC, ranked.sender_name`,
            [groupJids, fromTimestamp, toTimestamp, hiddenTypes]
        ),
    ])

    const reportsByGroup = new Map<string, ReportSliceRow[]>()
    for (const row of reports.rows) {
        const list = reportsByGroup.get(row.group_jid) ?? []
        list.push(row)
        reportsByGroup.set(row.group_jid, list)
    }
    const errorsByGroup = new Map(errors.rows.map((row) => [row.group_jid, row.error_count]))
    const leaderByGroup = new Map(leaders.rows.map((row) => [row.group_jid, row]))
    const withMentions = await resolveMentionedText(activity.rows.map((row) => row.latest_text))

    const groups = activity.rows.map((row): OverviewGroup => {
        const slices = reportsByGroup.get(row.jid) ?? []
        const latestRow = slices.reduce<ReportSliceRow | null>((best, slice) => {
            if (!best || reportSortKey(slice) > reportSortKey(best)) return slice
            return best
        }, null)
        const issueCount = slices.reduce((count, slice) => count + (sliceIssues(slice).length > 0 ? 1 : 0), 0)
        const leader = leaderByGroup.get(row.jid)
        const messageCount = row.message_count
        return {
            jid: row.jid,
            name: row.name,
            messageCount,
            senderCount: row.sender_count,
            latestTimestamp: row.latest_timestamp === null ? null : Number(row.latest_timestamp),
            latestText: withMentions(row.latest_text),
            media: {
                conversation: row.conversation_count,
                document: row.document_count,
                image: row.image_count,
                video: row.video_count,
            },
            topParticipant:
                leader && messageCount > 0
                    ? {
                          name: leader.sender_name,
                          messageCount: leader.message_count,
                          share: Math.round((leader.message_count / messageCount) * 100),
                      }
                    : null,
            dailySiteReport: {
                count: slices.length,
                issueCount,
                errorCount: errorsByGroup.get(row.jid) ?? 0,
                latest: latestRow ? toLatest(latestRow) : null,
            },
        }
    })

    groups.sort((left, right) => {
        const leftBusy = left.messageCount > 0 || left.dailySiteReport.count > 0 ? 1 : 0
        const rightBusy = right.messageCount > 0 || right.dailySiteReport.count > 0 ? 1 : 0
        if (leftBusy !== rightBusy) return rightBusy - leftBusy
        const timeDelta = activityTime(right) - activityTime(left)
        if (timeDelta !== 0) return timeDelta
        return left.name.localeCompare(right.name, 'zh-HK')
    })

    return {
        totals: {
            activeGroups: groups.length,
            messages: groups.reduce((sum, group) => sum + group.messageCount, 0),
            reports: groups.reduce((sum, group) => sum + group.dailySiteReport.count, 0),
            reportsNeedingReview: groups.reduce((sum, group) => sum + group.dailySiteReport.issueCount, 0),
        },
        groups,
    }
}

const REPORT_SECTION_KEY = 'overview_report_section_v1'

function sectionJids(value: unknown): string[] {
    if (!value || typeof value !== 'object') return []
    const jids = (value as { jids?: unknown }).jids
    if (!Array.isArray(jids)) return []
    return [
        ...new Set(
            jids.filter((jid): jid is string => typeof jid === 'string' && jid.length > 0 && jid.length <= 128)
        ),
    ]
}

export async function getReportSectionJids(): Promise<string[]> {
    return sectionJids(await getAppSetting(REPORT_SECTION_KEY))
}

export async function setReportSectionJids(jids: string[]): Promise<string[]> {
    const saved = sectionJids({ jids })
    await setAppSetting(REPORT_SECTION_KEY, { jids: saved })
    return saved
}
