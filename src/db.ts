import { Pool } from 'pg'
import { config, matchesGroupPattern } from './config.js'
import { log } from './log.js'

export const pool = new Pool({ connectionString: config.databaseUrl })

export async function initDb(): Promise<void> {
    try {
        await pool.query(`
        CREATE TABLE IF NOT EXISTS groups (
            jid TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            tracked BOOLEAN NOT NULL DEFAULT TRUE,
            deleted_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS senders (
            jid TEXT PRIMARY KEY,
            display_name TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS messages (
            message_id TEXT PRIMARY KEY,
            group_jid TEXT NOT NULL REFERENCES groups(jid),
            sender_jid TEXT REFERENCES senders(jid),
            message_secret TEXT,
            message_type TEXT,
            text_content TEXT,
            media_path TEXT,
            reply_to_id TEXT,
            quoted_message TEXT,
            timestamp BIGINT,
            is_edited BOOLEAN NOT NULL DEFAULT FALSE,
            is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
            is_history BOOLEAN NOT NULL DEFAULT FALSE
        );

        CREATE TABLE IF NOT EXISTS reactions (
            target_message_id TEXT NOT NULL,
            sender_jid TEXT NOT NULL REFERENCES senders(jid),
            group_jid TEXT NOT NULL REFERENCES groups(jid),
            emoji TEXT NOT NULL,
            timestamp BIGINT NOT NULL,
            is_history BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (target_message_id, sender_jid)
        );

        CREATE INDEX IF NOT EXISTS messages_group_timestamp_idx
            ON messages (group_jid, timestamp DESC, message_id DESC);

        CREATE INDEX IF NOT EXISTS messages_media_timestamp_idx
            ON messages (timestamp DESC, message_id DESC)
            WHERE media_path IS NOT NULL AND is_deleted = FALSE;
    `)

        // Reactions used to be stored as empty message rows that carried neither
        // the emoji nor the message they belonged to, so there is nothing to migrate.
        const legacy = await pool.query(
            `DELETE FROM messages WHERE message_type = 'reactionMessage'`
        )
        if (legacy.rowCount) {
            log.info({ count: legacy.rowCount }, 'db.legacy_reactions_removed')
        }
        log.info('db.schema_ready')
    } catch (err) {
        const e = err as { code?: string }
        if (e.code === '28000') {
            log.error(
                {
                    err,
                    code: e.code,
                    hint: 'Use docker compose up, or set DATABASE_URL to Compose Postgres on localhost:5433',
                },
                'db.role_missing'
            )
        }
        throw err
    }
}

export async function upsertGroup(jid: string, name: string, tracked: boolean): Promise<void> {
    await pool.query(
        `INSERT INTO groups (jid, name, tracked, deleted_at, updated_at)
         VALUES ($1, $2, $3, NULL, NOW())
         ON CONFLICT (jid) DO UPDATE SET
            name = EXCLUDED.name,
            tracked = EXCLUDED.tracked,
            deleted_at = CASE WHEN EXCLUDED.tracked THEN NULL ELSE groups.deleted_at END,
            updated_at = NOW()`,
        [jid, name, tracked]
    )
}

export async function markGroupDeleted(jid: string): Promise<void> {
    await pool.query(
        `UPDATE groups SET deleted_at = NOW(), tracked = FALSE, updated_at = NOW() WHERE jid = $1`,
        [jid]
    )
}

export async function upsertSender(jid: string, displayName: string): Promise<void> {
    await pool.query(
        `INSERT INTO senders (jid, display_name, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (jid) DO UPDATE SET
            display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), senders.display_name),
            updated_at = NOW()`,
        [jid, displayName]
    )
}

export type MessageRow = {
    messageId: string
    groupJid: string
    senderJid: string | null
    messageSecret: string | null
    messageType: string
    textContent: string | null
    mediaPath: string | null
    replyToId: string | null
    quotedMessage: string | null
    timestamp: number
    isHistory: boolean
}

export async function insertMessage(row: MessageRow): Promise<void> {
    await pool.query(
        `INSERT INTO messages (
            message_id, group_jid, sender_jid, message_secret, message_type,
            text_content, media_path, reply_to_id, quoted_message, timestamp,
            is_edited, is_deleted, is_history
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, FALSE, FALSE, $11)
         ON CONFLICT (message_id) DO NOTHING`,
        [
            row.messageId,
            row.groupJid,
            row.senderJid,
            row.messageSecret,
            row.messageType,
            row.textContent,
            row.mediaPath,
            row.replyToId,
            row.quotedMessage,
            row.timestamp,
            row.isHistory,
        ]
    )
}

export type ReactionRow = {
    targetMessageId: string
    groupJid: string
    senderJid: string
    emoji: string
    timestamp: number
    isHistory: boolean
}

export async function upsertReaction(row: ReactionRow): Promise<void> {
    await pool.query(
        `INSERT INTO reactions (
            target_message_id, sender_jid, group_jid, emoji, timestamp, is_history, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6, NOW())
         ON CONFLICT (target_message_id, sender_jid) DO UPDATE SET
            emoji = EXCLUDED.emoji,
            group_jid = EXCLUDED.group_jid,
            timestamp = EXCLUDED.timestamp,
            is_history = EXCLUDED.is_history,
            updated_at = NOW()
         WHERE reactions.timestamp <= EXCLUDED.timestamp`,
        [
            row.targetMessageId,
            row.senderJid,
            row.groupJid,
            row.emoji,
            row.timestamp,
            row.isHistory,
        ]
    )
}

export async function removeReaction(
    targetMessageId: string,
    senderJid: string,
    timestamp: number
): Promise<void> {
    await pool.query(
        `DELETE FROM reactions
         WHERE target_message_id = $1 AND sender_jid = $2 AND timestamp <= $3`,
        [targetMessageId, senderJid, timestamp]
    )
}

export type MessageReaction = {
    emoji: string
    count: number
    senders: string[]
}

async function loadReactions(messageIds: string[]): Promise<Map<string, MessageReaction[]>> {
    const byMessage = new Map<string, MessageReaction[]>()
    if (messageIds.length === 0) return byMessage

    const result = await pool.query<{
        target_message_id: string
        emoji: string
        sender_label: string
    }>(
        `SELECT
            r.target_message_id,
            r.emoji,
            COALESCE(NULLIF(s.display_name, ''), r.sender_jid) AS sender_label
         FROM reactions r
         LEFT JOIN senders s ON s.jid = r.sender_jid
         WHERE r.target_message_id = ANY($1::text[])
         ORDER BY r.timestamp ASC, r.sender_jid ASC`,
        [messageIds]
    )

    for (const row of result.rows) {
        const reactions = byMessage.get(row.target_message_id) ?? []
        const existing = reactions.find((reaction) => reaction.emoji === row.emoji)
        if (existing) {
            existing.count += 1
            existing.senders.push(row.sender_label)
        } else {
            reactions.push({ emoji: row.emoji, count: 1, senders: [row.sender_label] })
        }
        byMessage.set(row.target_message_id, reactions)
    }

    return byMessage
}

export async function getMessageSecret(messageId: string): Promise<string | undefined> {
    const result = await pool.query<{ message_secret: string | null }>(
        'SELECT message_secret FROM messages WHERE message_id = $1',
        [messageId]
    )
    return result.rows[0]?.message_secret ?? undefined
}

export async function markMessageEdited(messageId: string, textContent: string): Promise<void> {
    await pool.query(
        'UPDATE messages SET text_content = $1, is_edited = TRUE WHERE message_id = $2',
        [textContent, messageId]
    )
}

export async function markMessagesDeleted(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return
    await pool.query(
        'UPDATE messages SET is_deleted = TRUE WHERE message_id = ANY($1::text[])',
        [messageIds]
    )
}

async function matchingGroupJids(): Promise<string[]> {
    const result = await pool.query<{ jid: string; name: string }>('SELECT jid, name FROM groups')
    return result.rows.filter((row) => matchesGroupPattern(row.name)).map((row) => row.jid)
}

export async function groupMatchesPattern(jid: string): Promise<boolean> {
    const result = await pool.query<{ name: string }>('SELECT name FROM groups WHERE jid = $1', [jid])
    return matchesGroupPattern(result.rows[0]?.name)
}

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
            latest.timestamp::text AS latest_timestamp,
            latest.text_content AS latest_text
         FROM groups g
         LEFT JOIN messages m
           ON m.group_jid = g.jid
          AND m.timestamp >= $1
          AND m.timestamp < $2
         LEFT JOIN LATERAL (
            SELECT timestamp, text_content
            FROM messages
            WHERE group_jid = g.jid
              AND timestamp >= $1
              AND timestamp < $2
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
        [fromTimestamp, toTimestamp, groupJids]
    )

    return result.rows.map((row) => ({
        jid: row.jid,
        name: row.name,
        tracked: row.tracked,
        deletedAt: row.deleted_at?.toISOString() ?? null,
        messageCount: row.message_count,
        senderCount: row.sender_count,
        latestTimestamp: row.latest_timestamp === null ? null : Number(row.latest_timestamp),
        latestText: row.latest_text,
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
    timestamp: number
    isEdited: boolean
    isDeleted: boolean
    isHistory: boolean
    hasMedia: boolean
    reactions: MessageReaction[]
}

type DashboardMessageRow = {
    message_id: string
    sender_jid: string | null
    sender_name: string | null
    message_type: string
    text_content: string | null
    reply_to_id: string | null
    quoted_message: string | null
    timestamp: string
    is_edited: boolean
    is_deleted: boolean
    is_history: boolean
    has_media: boolean
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
            m.timestamp::text,
            m.is_edited,
            m.is_deleted,
            m.is_history,
            (m.media_path IS NOT NULL) AS has_media
         FROM messages m
         LEFT JOIN senders s ON s.jid = m.sender_jid
         WHERE m.group_jid = $1
           AND m.timestamp >= $2
           AND m.timestamp < $3
           AND (
                $4::bigint IS NULL
                OR m.timestamp < $4
                OR (m.timestamp = $4 AND m.message_id < $5)
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
    const reactions = await loadReactions(pageRows.map((row) => row.message_id))

    return {
        messages: pageRows.map((row) => ({
            messageId: row.message_id,
            senderJid: row.sender_jid,
            senderName: row.sender_name,
            messageType: row.message_type,
            textContent: row.text_content,
            replyToId: row.reply_to_id,
            quotedMessage: row.quoted_message,
            timestamp: Number(row.timestamp),
            isEdited: row.is_edited,
            isDeleted: row.is_deleted,
            isHistory: row.is_history,
            hasMedia: row.has_media,
            reactions: reactions.get(row.message_id) ?? [],
        })),
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
}

type AlbumMediaRow = {
    message_id: string
    group_jid: string
    group_name: string
    sender_name: string | null
    message_type: string
    text_content: string | null
    timestamp: string
}

export async function listAlbumMedia(
    fromTimestamp: number,
    toTimestamp: number,
    messageTypes: string[],
    limit: number,
    groupJid?: string,
    cursor?: MessageCursor
): Promise<{ items: AlbumMedia[]; nextCursor: MessageCursor | null }> {
    const allowedJids = await matchingGroupJids()
    const scopedJid = groupJid && allowedJids.includes(groupJid) ? groupJid : groupJid ? '' : null
    if (allowedJids.length === 0 || scopedJid === '') {
        return { items: [], nextCursor: null }
    }

    const result = await pool.query<AlbumMediaRow>(
        `SELECT
            m.message_id,
            m.group_jid,
            g.name AS group_name,
            s.display_name AS sender_name,
            m.message_type,
            m.text_content,
            m.timestamp::text
         FROM messages m
         JOIN groups g ON g.jid = m.group_jid
         LEFT JOIN senders s ON s.jid = m.sender_jid
         WHERE m.media_path IS NOT NULL
           AND m.is_deleted = FALSE
           AND m.timestamp >= $1
           AND m.timestamp < $2
           AND m.message_type = ANY($3::text[])
           AND m.group_jid = ANY($4::text[])
           AND ($5::text IS NULL OR m.group_jid = $5)
           AND (
                $6::bigint IS NULL
                OR m.timestamp < $6
                OR (m.timestamp = $6 AND m.message_id < $7)
           )
         ORDER BY m.timestamp DESC, m.message_id DESC
         LIMIT $8`,
        [
            fromTimestamp,
            toTimestamp,
            messageTypes,
            allowedJids,
            scopedJid,
            cursor?.timestamp ?? null,
            cursor?.messageId ?? null,
            limit + 1,
        ]
    )

    const hasMore = result.rows.length > limit
    const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows
    const last = pageRows.at(-1)
    return {
        items: pageRows.map((row) => ({
            messageId: row.message_id,
            groupJid: row.group_jid,
            groupName: row.group_name,
            senderName: row.sender_name,
            messageType: row.message_type,
            textContent: row.text_content,
            timestamp: Number(row.timestamp),
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
    groupJid?: string
): Promise<AlbumCounts> {
    const allowedJids = await matchingGroupJids()
    const scopedJid = groupJid && allowedJids.includes(groupJid) ? groupJid : groupJid ? '' : null
    const empty: AlbumCounts = { image: 0, video: 0, document: 0, audio: 0, sticker: 0 }
    if (allowedJids.length === 0 || scopedJid === '') return empty

    const result = await pool.query<AlbumCountRow>(
        `SELECT
            CASE m.message_type
                WHEN 'imageMessage' THEN 'image'
                WHEN 'videoMessage' THEN 'video'
                WHEN 'documentMessage' THEN 'document'
                WHEN 'audioMessage' THEN 'audio'
                WHEN 'stickerMessage' THEN 'sticker'
            END AS category,
            COUNT(*)::int AS count
         FROM messages m
         WHERE m.media_path IS NOT NULL
           AND m.is_deleted = FALSE
           AND m.timestamp >= $1
           AND m.timestamp < $2
           AND m.group_jid = ANY($3::text[])
           AND ($4::text IS NULL OR m.group_jid = $4)
           AND m.message_type = ANY($5::text[])
         GROUP BY category`,
        [
            fromTimestamp,
            toTimestamp,
            allowedJids,
            scopedJid,
            ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'],
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
    groupJid?: string
): Promise<AlbumDownloadMedia[]> {
    const allowedJids = await matchingGroupJids()
    const scopedJid = groupJid && allowedJids.includes(groupJid) ? groupJid : groupJid ? '' : null
    if (allowedJids.length === 0 || scopedJid === '') return []

    const result = await pool.query<AlbumMediaRow & { media_path: string }>(
        `SELECT
            m.message_id,
            m.group_jid,
            g.name AS group_name,
            s.display_name AS sender_name,
            m.message_type,
            m.text_content,
            m.timestamp::text,
            m.media_path
         FROM messages m
         JOIN groups g ON g.jid = m.group_jid
         LEFT JOIN senders s ON s.jid = m.sender_jid
         WHERE m.message_id = ANY($1::text[])
           AND m.media_path IS NOT NULL
           AND m.is_deleted = FALSE
           AND m.timestamp >= $2
           AND m.timestamp < $3
           AND m.message_type = ANY($4::text[])
           AND m.group_jid = ANY($5::text[])
           AND ($6::text IS NULL OR m.group_jid = $6)
         ORDER BY m.timestamp ASC, m.message_id ASC`,
        [messageIds, fromTimestamp, toTimestamp, messageTypes, allowedJids, scopedJid]
    )

    return result.rows.map((row) => ({
        messageId: row.message_id,
        groupJid: row.group_jid,
        groupName: row.group_name,
        senderName: row.sender_name,
        messageType: row.message_type,
        textContent: row.text_content,
        timestamp: Number(row.timestamp),
        mediaPath: row.media_path,
    }))
}
