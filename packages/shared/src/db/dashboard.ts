import { matchesGroupPattern } from '../config.js'
import { matchingGroupJids, groupMatchesPattern } from './groups.js'
import { pool } from './pool.js'
import { loadReactions, type MessageReaction } from './reactions.js'
import {
    DASHBOARD_HIDDEN_MESSAGE_TYPES,
    DASHBOARD_HIDDEN_TYPES_SQL,
    FILE_NAME_SQL,
    FILE_NAME_SQL_BARE,
    likeContainsPattern,
} from './sql.js'

export type DashboardGroup = {
    jid: string
    name: string
    tracked: boolean
    deletedAt: string | null
    messageCount: number
    senderCount: number
    latestTimestamp: number | null
    latestText: string | null
}

type DashboardGroupRow = {
    jid: string
    name: string
    tracked: boolean
    deleted_at: Date | null
    message_count: number
    sender_count: number
    latest_timestamp: string | null
    latest_text: string | null
}

export async function listDashboardGroups(
    fromTimestamp: number,
    toTimestamp: number
): Promise<DashboardGroup[]> {
    const groupJids = await matchingGroupJids()
    if (groupJids.length === 0) return []

    const result = await pool.query<DashboardGroupRow>(
        `SELECT
            g.jid,
            g.name,
            g.tracked,
            g.deleted_at,
            COUNT(m.message_id)::int AS message_count,
            COUNT(DISTINCT m.sender_jid)::int AS sender_count,
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
         GROUP BY
            g.jid, g.name, g.tracked, g.deleted_at,
            latest.timestamp, latest.text_content
         ORDER BY
            (COUNT(m.message_id) > 0) DESC,
            latest.timestamp DESC NULLS LAST,
            g.name ASC`,
        [fromTimestamp, toTimestamp, groupJids, [...DASHBOARD_HIDDEN_MESSAGE_TYPES]]
    )

    const withMentions = await resolveMentionedText(result.rows.map((row) => row.latest_text))
    return result.rows.map((row) => ({
        jid: row.jid,
        name: row.name,
        tracked: row.tracked,
        deletedAt: row.deleted_at?.toISOString() ?? null,
        messageCount: row.message_count,
        senderCount: row.sender_count,
        latestTimestamp: row.latest_timestamp === null ? null : Number(row.latest_timestamp),
        latestText: withMentions(row.latest_text),
    }))
}

export type MessageCursor = {
    timestamp: number
    messageId: string
}

export type DashboardMessage = {
    messageId: string
    senderJid: string | null
    senderName: string | null
    messageType: string
    textContent: string | null
    replyToId: string | null
    quotedMessage: string | null
    quotedMessageType: string | null
    quotedMediaId: string | null
    quotedMediaType: string | null
    quotedFileName: string | null
    timestamp: number
    isEdited: boolean
    isDeleted: boolean
    isHistory: boolean
    isForwarded: boolean
    hasMedia: boolean
    fileName: string | null
    reactions: MessageReaction[]
    albumItems: DashboardMessage[]
    albumExpectedImages: number | null
    albumExpectedVideos: number | null
    siteReportExtracted: boolean
    siteReportFailed: boolean
    siteReportFailureDetail: string | null
    /** Latest daily_site_report workflow_runs.status (or null if never run). */
    siteReportStatus: string | null
    siteReportStatusDetail: string | null
}

type DashboardMessageRow = {
    message_id: string
    sender_jid: string | null
    sender_name: string | null
    message_type: string
    text_content: string | null
    reply_to_id: string | null
    quoted_message: string | null
    quoted_message_type: string | null
    quoted_media_id: string | null
    quoted_media_type: string | null
    quoted_file_name: string | null
    timestamp: string
    is_edited: boolean
    is_deleted: boolean
    is_history: boolean
    is_forwarded: boolean
    has_media: boolean
    file_name: string | null
    album_expected_images: number | null
    album_expected_videos: number | null
    site_report_extracted: boolean
    site_report_workflow_status: string | null
    site_report_workflow_detail: string | null
}

const MENTION_RE = /@(\d{8,})/g

function mentionUsersIn(...texts: Array<string | null | undefined>): string[] {
    const users = new Set<string>()
    for (const text of texts) {
        if (!text) continue
        for (const match of text.matchAll(MENTION_RE)) {
            if (match[1]) users.add(match[1])
        }
    }
    return [...users]
}

function applyMentionNames(text: string | null, names: Map<string, string>): string | null {
    if (!text) return text
    return text.replace(MENTION_RE, (full, user: string) => {
        const name = names.get(user)
        return name ? `@${name}` : full
    })
}

async function loadMentionNames(users: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    if (users.length === 0) return names
    const result = await pool.query<{ user_part: string; display_name: string }>(
        `SELECT split_part(jid, '@', 1) AS user_part, display_name
         FROM senders
         WHERE split_part(jid, '@', 1) = ANY($1::text[])
           AND NULLIF(btrim(display_name), '') IS NOT NULL
           AND display_name !~ '^[0-9]{8,}$'`,
        [users]
    )
    for (const row of result.rows) {
        if (!names.has(row.user_part)) names.set(row.user_part, row.display_name)
    }
    return names
}

async function resolveMentionedText(
    texts: Array<string | null | undefined>
): Promise<(text: string | null) => string | null> {
    const names = await loadMentionNames(mentionUsersIn(...texts))
    return (text) => applyMentionNames(text, names)
}

type QuotedTarget = {
    messageType: string
    textContent: string | null
    mediaId: string | null
    mediaType: string | null
    fileName: string | null
}

async function loadQuotedTargets(messageIds: string[]): Promise<Map<string, QuotedTarget>> {
    const uniqueIds = [...new Set(messageIds.filter(Boolean))]
    const targets = new Map<string, QuotedTarget>()
    if (uniqueIds.length === 0) return targets

    const result = await pool.query<{
        message_id: string
        message_type: string
        text_content: string | null
        has_media: boolean
        file_name: string | null
    }>(
        `SELECT
            message_id,
            message_type,
            text_content,
            (media_path IS NOT NULL) AS has_media,
            CASE
                WHEN media_path IS NULL THEN NULL
                ELSE ${FILE_NAME_SQL_BARE}
            END AS file_name
         FROM messages
         WHERE message_id = ANY($1::text[])`,
        [uniqueIds]
    )

    const albumIds: string[] = []
    for (const row of result.rows) {
        targets.set(row.message_id, {
            messageType: row.message_type,
            textContent: row.text_content,
            mediaId: row.has_media ? row.message_id : null,
            mediaType: row.has_media ? row.message_type : null,
            fileName: row.file_name,
        })
        if (row.message_type === 'albumMessage' && !row.has_media) {
            albumIds.push(row.message_id)
        }
    }

    if (albumIds.length === 0) return targets

    const previews = await pool.query<{
        album_parent_id: string
        message_id: string
        message_type: string
        file_name: string | null
    }>(
        `SELECT DISTINCT ON (album_parent_id)
            album_parent_id,
            message_id,
            message_type,
            ${FILE_NAME_SQL_BARE} AS file_name
         FROM messages
         WHERE album_parent_id = ANY($1::text[])
           AND media_path IS NOT NULL
         ORDER BY album_parent_id, album_index ASC NULLS LAST, timestamp ASC, message_id ASC`,
        [albumIds]
    )
    for (const preview of previews.rows) {
        const current = targets.get(preview.album_parent_id)
        if (!current || current.mediaId) continue
        targets.set(preview.album_parent_id, {
            ...current,
            mediaId: preview.message_id,
            mediaType: preview.message_type,
            fileName: preview.file_name,
        })
    }
    return targets
}

function applyQuotedTarget(row: DashboardMessageRow, quoted?: QuotedTarget): DashboardMessageRow {
    return {
        ...row,
        quoted_message: row.quoted_message || quoted?.textContent || null,
        quoted_message_type: quoted?.messageType || null,
        quoted_media_id: quoted?.mediaId ?? null,
        quoted_media_type: quoted?.mediaType ?? null,
        quoted_file_name: quoted?.fileName ?? null,
    }
}

function toDashboardMessage(
    row: DashboardMessageRow,
    reactions: MessageReaction[] = [],
    albumItems: DashboardMessage[] = []
): DashboardMessage {
    return {
        messageId: row.message_id,
        senderJid: row.sender_jid,
        senderName: row.sender_name,
        messageType: row.message_type,
        textContent: row.text_content,
        replyToId: row.reply_to_id,
        quotedMessage: row.quoted_message,
        quotedMessageType: row.quoted_message_type,
        quotedMediaId: row.quoted_media_id,
        quotedMediaType: row.quoted_media_type,
        quotedFileName: row.quoted_file_name,
        timestamp: Number(row.timestamp),
        isEdited: row.is_edited,
        isDeleted: row.is_deleted,
        isHistory: row.is_history,
        isForwarded: row.is_forwarded,
        hasMedia: row.has_media,
        fileName: row.file_name,
        reactions,
        albumItems,
        albumExpectedImages: row.album_expected_images ?? null,
        albumExpectedVideos: row.album_expected_videos ?? null,
        siteReportExtracted: row.site_report_extracted,
        siteReportFailed:
            !row.site_report_extracted && row.site_report_workflow_status === 'error',
        siteReportFailureDetail:
            !row.site_report_extracted && row.site_report_workflow_status === 'error'
                ? row.site_report_workflow_detail?.trim() || null
                : null,
        siteReportStatus: row.site_report_workflow_status,
        siteReportStatusDetail: row.site_report_workflow_detail?.trim() || null,
    }
}

export async function listDashboardMessages(
    groupJid: string,
    fromTimestamp: number,
    toTimestamp: number,
    limit: number,
    cursor?: MessageCursor
): Promise<{ messages: DashboardMessage[]; nextCursor: MessageCursor | null }> {
    if (!(await groupMatchesPattern(groupJid))) {
        return { messages: [], nextCursor: null }
    }

    const result = await pool.query<DashboardMessageRow>(
        `SELECT
            m.message_id,
            m.sender_jid,
            s.display_name AS sender_name,
            m.message_type,
            m.text_content,
            m.reply_to_id,
            m.quoted_message,
            EXTRACT(EPOCH FROM m.timestamp)::bigint AS timestamp,
            m.is_edited,
            m.is_deleted,
            m.is_history,
            m.is_forwarded,
            (m.media_path IS NOT NULL) AS has_media,
            CASE
                WHEN m.media_path IS NULL THEN NULL
                ELSE ${FILE_NAME_SQL}
            END AS file_name,
            m.album_expected_images,
            m.album_expected_videos,
            EXISTS (
                SELECT 1
                FROM daily_site_reports dsr
                WHERE dsr.message_id = m.message_id
                  AND dsr.is_deleted = FALSE
            ) AS site_report_extracted,
            (
                SELECT wr.status
                FROM workflow_runs wr
                WHERE wr.message_id = m.message_id
                  AND wr.workflow_name = 'daily_site_report'
                ORDER BY wr.created_at DESC, wr.id DESC
                LIMIT 1
            ) AS site_report_workflow_status,
            (
                SELECT wr.detail
                FROM workflow_runs wr
                WHERE wr.message_id = m.message_id
                  AND wr.workflow_name = 'daily_site_report'
                ORDER BY wr.created_at DESC, wr.id DESC
                LIMIT 1
            ) AS site_report_workflow_detail
         FROM messages m
         LEFT JOIN senders s ON s.jid = m.sender_jid
         WHERE m.group_jid = $1
           AND m.timestamp >= to_timestamp($2)
           AND m.timestamp < to_timestamp($3)
           AND ${DASHBOARD_HIDDEN_TYPES_SQL}
           AND NOT EXISTS (
                SELECT 1
                FROM messages parent
                WHERE parent.message_id = m.album_parent_id
                  AND (
                      parent.is_deleted = FALSE
                      OR m.is_deleted = TRUE
                  )
           )
           AND (
                $4::bigint IS NULL
                OR m.timestamp < to_timestamp($4)
                OR (m.timestamp = to_timestamp($4) AND m.message_id < $5)
           )
         ORDER BY m.timestamp DESC, m.message_id DESC
         LIMIT $6`,
        [
            groupJid,
            fromTimestamp,
            toTimestamp,
            cursor?.timestamp ?? null,
            cursor?.messageId ?? null,
            limit + 1,
        ]
    )

    const hasMore = result.rows.length > limit
    const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows
    const last = pageRows.at(-1)
    const albumIds = pageRows
        .filter((row) => row.message_type === 'albumMessage')
        .map((row) => row.message_id)
    const liveAlbumIds = pageRows
        .filter((row) => row.message_type === 'albumMessage' && !row.is_deleted)
        .map((row) => row.message_id)
    const deletedAlbumIds = pageRows
        .filter((row) => row.message_type === 'albumMessage' && row.is_deleted)
        .map((row) => row.message_id)

    const childrenByParent = new Map<string, DashboardMessageRow[]>()
    if (albumIds.length > 0) {
        const children = await pool.query<DashboardMessageRow & { album_parent_id: string }>(
            `SELECT
                m.message_id,
                m.sender_jid,
                s.display_name AS sender_name,
                m.message_type,
                m.text_content,
                m.reply_to_id,
                m.quoted_message,
                EXTRACT(EPOCH FROM m.timestamp)::bigint AS timestamp,
                m.is_edited,
                m.is_deleted,
                m.is_history,
                m.is_forwarded,
                (m.media_path IS NOT NULL) AS has_media,
                CASE
                    WHEN m.media_path IS NULL THEN NULL
                    ELSE ${FILE_NAME_SQL}
                END AS file_name,
                m.album_expected_images,
                m.album_expected_videos,
                m.album_parent_id,
                EXISTS (
                    SELECT 1
                    FROM daily_site_reports dsr
                    WHERE dsr.message_id = m.message_id
                      AND dsr.is_deleted = FALSE
                ) AS site_report_extracted,
                (
                    SELECT wr.status
                    FROM workflow_runs wr
                    WHERE wr.message_id = m.message_id
                      AND wr.workflow_name = 'daily_site_report'
                    ORDER BY wr.created_at DESC, wr.id DESC
                    LIMIT 1
                ) AS site_report_workflow_status,
                (
                    SELECT wr.detail
                    FROM workflow_runs wr
                    WHERE wr.message_id = m.message_id
                      AND wr.workflow_name = 'daily_site_report'
                    ORDER BY wr.created_at DESC, wr.id DESC
                    LIMIT 1
                ) AS site_report_workflow_detail
             FROM messages m
             LEFT JOIN senders s ON s.jid = m.sender_jid
             WHERE m.album_parent_id = ANY($1::text[])
                OR (m.album_parent_id = ANY($2::text[]) AND m.is_deleted)
             ORDER BY m.album_index ASC NULLS LAST, m.timestamp ASC, m.message_id ASC`,
            [liveAlbumIds, deletedAlbumIds]
        )
        for (const child of children.rows) {
            const items = childrenByParent.get(child.album_parent_id) ?? []
            items.push(child)
            childrenByParent.set(child.album_parent_id, items)
        }
    }

    const childRows = [...childrenByParent.values()].flat()
    const quotedTargets = await loadQuotedTargets(
        [...pageRows, ...childRows]
            .map((row) => row.reply_to_id)
            .filter((id): id is string => Boolean(id))
    )
    const quotedPageRows = pageRows.map((row) =>
        applyQuotedTarget(row, row.reply_to_id ? quotedTargets.get(row.reply_to_id) : undefined)
    )
    const quotedChildrenByParent = new Map<string, DashboardMessageRow[]>()
    for (const [parentId, items] of childrenByParent) {
        quotedChildrenByParent.set(
            parentId,
            items.map((child) =>
                applyQuotedTarget(
                    child,
                    child.reply_to_id ? quotedTargets.get(child.reply_to_id) : undefined
                )
            )
        )
    }

    const reactionIds = [
        ...quotedPageRows.map((row) => row.message_id),
        ...[...quotedChildrenByParent.values()].flat().map((row) => row.message_id),
    ]
    const reactions = await loadReactions(reactionIds)
    const withMentions = await resolveMentionedText([
        ...quotedPageRows.flatMap((row) => [row.text_content, row.quoted_message]),
        ...[...quotedChildrenByParent.values()]
            .flat()
            .flatMap((row) => [row.text_content, row.quoted_message]),
    ])

    return {
        messages: quotedPageRows.map((row) => {
            const albumChildren = quotedChildrenByParent.get(row.message_id) ?? []
            return toDashboardMessage(
                {
                    ...row,
                    text_content: withMentions(row.text_content),
                    quoted_message: withMentions(row.quoted_message),
                    is_forwarded:
                        row.is_forwarded || albumChildren.some((child) => child.is_forwarded),
                },
                reactions.get(row.message_id) ?? [],
                albumChildren.map((child) =>
                    toDashboardMessage(
                        {
                            ...child,
                            text_content: withMentions(child.text_content),
                            quoted_message: withMentions(child.quoted_message),
                        },
                        reactions.get(child.message_id) ?? []
                    )
                )
            )
        }),
        nextCursor:
            hasMore && last
                ? { timestamp: Number(last.timestamp), messageId: last.message_id }
                : null,
    }
}

export async function getDashboardMedia(
    messageId: string
): Promise<{ mediaPath: string; messageType: string } | undefined> {
    const result = await pool.query<{ media_path: string; message_type: string; group_name: string }>(
        `SELECT m.media_path, m.message_type, g.name AS group_name
         FROM messages m
         JOIN groups g ON g.jid = m.group_jid
         WHERE m.message_id = $1 AND m.media_path IS NOT NULL`,
        [messageId]
    )
    const row = result.rows[0]
    if (!row || !matchesGroupPattern(row.group_name)) return undefined
    return { mediaPath: row.media_path, messageType: row.message_type }
}

export type AlbumMedia = {
    messageId: string
    groupJid: string
    groupName: string
    senderName: string | null
    messageType: string
    textContent: string | null
    timestamp: number
    fileName: string | null
}

type AlbumMediaRow = {
    message_id: string
    group_jid: string
    group_name: string
    sender_name: string | null
    message_type: string
    text_content: string | null
    timestamp: string
    file_name: string | null
}

function resolveAlbumGroupFilter(
    allowedJids: string[],
    requested?: string[]
): { scopedJids: string[] | null; empty: boolean } {
    if (allowedJids.length === 0) return { scopedJids: null, empty: true }
    if (requested === undefined) return { scopedJids: null, empty: false }
    const scopedJids = requested.filter((jid) => allowedJids.includes(jid))
    return { scopedJids, empty: scopedJids.length === 0 }
}

export async function listAlbumMedia(
    fromTimestamp: number,
    toTimestamp: number,
    messageTypes: string[],
    limit: number,
    groupJids?: string[],
    cursor?: MessageCursor,
    fileNameQuery?: string
): Promise<{ items: AlbumMedia[]; nextCursor: MessageCursor | null }> {
    const allowedJids = await matchingGroupJids()
    const { scopedJids, empty } = resolveAlbumGroupFilter(allowedJids, groupJids)
    if (empty) {
        return { items: [], nextCursor: null }
    }

    const namePattern = fileNameQuery ? likeContainsPattern(fileNameQuery) : null
    const result = await pool.query<AlbumMediaRow>(
        `SELECT
            m.message_id,
            m.group_jid,
            g.name AS group_name,
            s.display_name AS sender_name,
            m.message_type,
            m.text_content,
            EXTRACT(EPOCH FROM m.timestamp)::bigint AS timestamp,
            ${FILE_NAME_SQL} AS file_name
         FROM messages m
         JOIN groups g ON g.jid = m.group_jid
         LEFT JOIN senders s ON s.jid = m.sender_jid
         WHERE m.media_path IS NOT NULL
           AND m.is_deleted = FALSE
           AND m.timestamp >= to_timestamp($1)
           AND m.timestamp < to_timestamp($2)
           AND m.message_type = ANY($3::text[])
           AND m.group_jid = ANY($4::text[])
           AND ($5::text[] IS NULL OR m.group_jid = ANY($5::text[]))
           AND (
                $6::bigint IS NULL
                OR m.timestamp < to_timestamp($6)
                OR (m.timestamp = to_timestamp($6) AND m.message_id < $7)
           )
           AND ($9::text IS NULL OR ${FILE_NAME_SQL} ILIKE $9 ESCAPE E'\\\\')
         ORDER BY m.timestamp DESC, m.message_id DESC
         LIMIT $8`,
        [
            fromTimestamp,
            toTimestamp,
            messageTypes,
            allowedJids,
            scopedJids,
            cursor?.timestamp ?? null,
            cursor?.messageId ?? null,
            limit + 1,
            namePattern,
        ]
    )

    const hasMore = result.rows.length > limit
    const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows
    const last = pageRows.at(-1)
    const withMentions = await resolveMentionedText(pageRows.map((row) => row.text_content))
    return {
        items: pageRows.map((row) => ({
            messageId: row.message_id,
            groupJid: row.group_jid,
            groupName: row.group_name,
            senderName: row.sender_name,
            messageType: row.message_type,
            textContent: withMentions(row.text_content),
            timestamp: Number(row.timestamp),
            fileName: row.file_name,
        })),
        nextCursor:
            hasMore && last
                ? { timestamp: Number(last.timestamp), messageId: last.message_id }
                : null,
    }
}

export type AlbumCounts = {
    image: number
    video: number
    document: number
    audio: number
    sticker: number
}

type AlbumCountRow = {
    category: keyof AlbumCounts
    count: number
}

export async function countAlbumMedia(
    fromTimestamp: number,
    toTimestamp: number,
    groupJids?: string[]
): Promise<AlbumCounts> {
    const allowedJids = await matchingGroupJids()
    const { scopedJids, empty } = resolveAlbumGroupFilter(allowedJids, groupJids)
    const emptyCounts: AlbumCounts = { image: 0, video: 0, document: 0, audio: 0, sticker: 0 }
    if (empty) return emptyCounts

    const result = await pool.query<AlbumCountRow>(
        `SELECT
            CASE m.message_type
                WHEN 'imageMessage' THEN 'image'
                WHEN 'videoMessage' THEN 'video'
                WHEN 'ptvMessage' THEN 'video'
                WHEN 'documentMessage' THEN 'document'
                WHEN 'audioMessage' THEN 'audio'
                WHEN 'stickerMessage' THEN 'sticker'
            END AS category,
            COUNT(*)::int AS count
         FROM messages m
         WHERE m.media_path IS NOT NULL
           AND m.is_deleted = FALSE
           AND m.timestamp >= to_timestamp($1)
           AND m.timestamp < to_timestamp($2)
           AND m.group_jid = ANY($3::text[])
           AND ($4::text[] IS NULL OR m.group_jid = ANY($4::text[]))
           AND m.message_type = ANY($5::text[])
         GROUP BY category`,
        [
            fromTimestamp,
            toTimestamp,
            allowedJids,
            scopedJids,
            [
                'imageMessage',
                'videoMessage',
                'ptvMessage',
                'documentMessage',
                'audioMessage',
                'stickerMessage',
            ],
        ]
    )

    const counts: AlbumCounts = { image: 0, video: 0, document: 0, audio: 0, sticker: 0 }
    for (const row of result.rows) counts[row.category] = row.count
    return counts
}

export type AlbumDownloadMedia = AlbumMedia & {
    mediaPath: string
}

export async function getAlbumMediaForDownload(
    messageIds: string[],
    fromTimestamp: number,
    toTimestamp: number,
    messageTypes: string[],
    groupJids?: string[]
): Promise<AlbumDownloadMedia[]> {
    const allowedJids = await matchingGroupJids()
    const { scopedJids, empty } = resolveAlbumGroupFilter(allowedJids, groupJids)
    if (empty) return []

    const result = await pool.query<AlbumMediaRow & { media_path: string }>(
        `SELECT
            m.message_id,
            m.group_jid,
            g.name AS group_name,
            s.display_name AS sender_name,
            m.message_type,
            m.text_content,
            EXTRACT(EPOCH FROM m.timestamp)::bigint AS timestamp,
            ${FILE_NAME_SQL} AS file_name,
            m.media_path
         FROM messages m
         JOIN groups g ON g.jid = m.group_jid
         LEFT JOIN senders s ON s.jid = m.sender_jid
         WHERE m.message_id = ANY($1::text[])
           AND m.media_path IS NOT NULL
           AND m.is_deleted = FALSE
           AND m.timestamp >= to_timestamp($2)
           AND m.timestamp < to_timestamp($3)
           AND m.message_type = ANY($4::text[])
           AND m.group_jid = ANY($5::text[])
           AND ($6::text[] IS NULL OR m.group_jid = ANY($6::text[]))
         ORDER BY m.timestamp ASC, m.message_id ASC`,
        [messageIds, fromTimestamp, toTimestamp, messageTypes, allowedJids, scopedJids]
    )

    const withMentions = await resolveMentionedText(result.rows.map((row) => row.text_content))
    return result.rows.map((row) => ({
        messageId: row.message_id,
        groupJid: row.group_jid,
        groupName: row.group_name,
        senderName: row.sender_name,
        messageType: row.message_type,
        textContent: withMentions(row.text_content),
        timestamp: Number(row.timestamp),
        fileName: row.file_name,
        mediaPath: row.media_path,
    }))
}
