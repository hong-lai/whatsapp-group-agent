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
            timestamp TIMESTAMPTZ,
            is_edited BOOLEAN NOT NULL DEFAULT FALSE,
            is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
            is_history BOOLEAN NOT NULL DEFAULT FALSE,
            is_forwarded BOOLEAN NOT NULL DEFAULT FALSE
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

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `)

        await migrateMessagesTimestamp()
        await migrateAlbumParents()
        await migrateForwarded()
        await migrateQuotedMessageType()

        await pool.query(`
        CREATE INDEX IF NOT EXISTS messages_group_timestamp_idx
            ON messages (group_jid, timestamp DESC, message_id DESC);

        CREATE INDEX IF NOT EXISTS messages_media_timestamp_idx
            ON messages (timestamp DESC, message_id DESC)
            WHERE media_path IS NOT NULL AND is_deleted = FALSE;

        CREATE INDEX IF NOT EXISTS messages_album_parent_idx
            ON messages (album_parent_id)
            WHERE album_parent_id IS NOT NULL;
    `)

        const placeholders = await pool.query(
            `UPDATE senders
             SET display_name = NULL, updated_at = NOW()
             WHERE display_name ~ '^[0-9]{8,}$'`
        )
        if (placeholders.rowCount) {
            log.info({ count: placeholders.rowCount }, 'db.placeholder_sender_names_cleared')
        }

        const groupSenders = await pool.query<{ jid: string }>(
            `SELECT jid FROM senders
             WHERE jid LIKE '%@g.us'
                OR jid LIKE '%@broadcast'
                OR jid LIKE '%@newsletter'`
        )
        if (groupSenders.rowCount) {
            const groupJids = groupSenders.rows.map((row) => row.jid)
            await pool.query(
                `DELETE FROM reactions WHERE sender_jid = ANY($1::text[])`,
                [groupJids]
            )
            await pool.query(
                `UPDATE messages SET sender_jid = NULL WHERE sender_jid = ANY($1::text[])`,
                [groupJids]
            )
            await pool.query(`DELETE FROM senders WHERE jid = ANY($1::text[])`, [groupJids])
            log.info({ count: groupJids.length }, 'db.group_senders_removed')
        }

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

async function migrateMessagesTimestamp(): Promise<void> {
    const column = await pool.query<{ data_type: string }>(
        `SELECT data_type
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'messages'
           AND column_name = 'timestamp'`
    )
    if (column.rows[0]?.data_type !== 'bigint') return

    await pool.query(`
        DROP INDEX IF EXISTS messages_group_timestamp_idx;
        DROP INDEX IF EXISTS messages_media_timestamp_idx;
        ALTER TABLE messages
            ALTER COLUMN timestamp TYPE TIMESTAMPTZ
            USING CASE
                WHEN timestamp IS NULL THEN NULL
                ELSE to_timestamp(timestamp)
            END
    `)
    log.info('db.messages_timestamp_migrated')
}

// History sync often strips messageAssociation. Group only within this window, and
// never across another album from the same sender. Live children carry parentMessageKey.
const ALBUM_ASSOCIATION_WINDOW_SECONDS = 300
const ALBUM_MEDIA_TYPES = ['imageMessage', 'videoMessage'] as const

async function migrateForwarded(): Promise<void> {
    await pool.query(
        `ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_forwarded BOOLEAN NOT NULL DEFAULT FALSE`
    )
}

async function migrateQuotedMessageType(): Promise<void> {
    await pool.query(`ALTER TABLE messages DROP COLUMN IF EXISTS quoted_message_type`)
}

async function migrateAlbumParents(): Promise<void> {
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS album_parent_id TEXT`)
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS album_index INTEGER`)

    const albums = await pool.query<{
        message_id: string
        group_jid: string
        sender_jid: string | null
        timestamp: string
    }>(
        `SELECT
            message_id,
            group_jid,
            sender_jid,
            EXTRACT(EPOCH FROM timestamp)::bigint::text AS timestamp
         FROM messages
         WHERE message_type = 'albumMessage' AND timestamp IS NOT NULL
         ORDER BY timestamp ASC, message_id ASC`
    )

    let attached = 0
    for (const album of albums.rows) {
        attached += await attachNearbyAlbumMedia({
            parentId: album.message_id,
            groupJid: album.group_jid,
            senderJid: album.sender_jid,
            timestamp: Number(album.timestamp),
        })
    }
    if (attached > 0) {
        log.info({ albums: albums.rowCount, attached }, 'db.album_parents_backfilled')
    }
    await fillMissingAlbumIndexes()
}

export async function attachNearbyAlbumMedia(row: {
    parentId: string
    groupJid: string
    senderJid: string | null
    timestamp: number
}): Promise<number> {
    const windowStart = row.timestamp - ALBUM_ASSOCIATION_WINDOW_SECONDS
    const windowEnd = row.timestamp + ALBUM_ASSOCIATION_WINDOW_SECONDS
    const result = await pool.query(
        `UPDATE messages SET album_parent_id = $1
         WHERE group_jid = $2
           AND sender_jid IS NOT DISTINCT FROM $3
           AND message_id <> $1
           AND message_type = ANY($4::text[])
           AND album_parent_id IS NULL
           AND timestamp >= GREATEST(
                to_timestamp($6),
                COALESCE(
                    (
                        SELECT MAX(prev_album.timestamp)
                        FROM messages prev_album
                        WHERE prev_album.group_jid = $2
                          AND prev_album.sender_jid IS NOT DISTINCT FROM $3
                          AND prev_album.message_type = 'albumMessage'
                          AND (
                            prev_album.timestamp < to_timestamp($5)
                            OR (
                                prev_album.timestamp = to_timestamp($5)
                                AND prev_album.message_id < $1
                            )
                          )
                    ),
                    '-infinity'::timestamptz
                )
           )
           AND timestamp < LEAST(
                to_timestamp($7),
                COALESCE(
                    (
                        SELECT MIN(next_album.timestamp)
                        FROM messages next_album
                        WHERE next_album.group_jid = $2
                          AND next_album.sender_jid IS NOT DISTINCT FROM $3
                          AND next_album.message_type = 'albumMessage'
                          AND (
                            next_album.timestamp > to_timestamp($5)
                            OR (
                                next_album.timestamp = to_timestamp($5)
                                AND next_album.message_id > $1
                            )
                          )
                    ),
                    'infinity'::timestamptz
                )
           )`,
        [
            row.parentId,
            row.groupJid,
            row.senderJid,
            [...ALBUM_MEDIA_TYPES],
            row.timestamp,
            windowStart,
            windowEnd,
        ]
    )
    const attached = result.rowCount ?? 0
    if (attached > 0) await fillMissingAlbumIndexes(row.parentId)
    return attached
}

export async function nextAlbumIndex(parentId: string): Promise<number> {
    const result = await pool.query<{ next: string | number }>(
        `SELECT COALESCE(MAX(album_index), -1) + 1 AS next
         FROM messages
         WHERE album_parent_id = $1`,
        [parentId]
    )
    return Number(result.rows[0]?.next ?? 0)
}

async function fillMissingAlbumIndexes(parentId?: string): Promise<void> {
    await pool.query(
        `WITH ranked AS (
            SELECT
                message_id,
                COALESCE(max_index, -1)
                    + ROW_NUMBER() OVER (
                        PARTITION BY album_parent_id
                        ORDER BY timestamp ASC, message_id ASC
                    ) AS album_index
            FROM (
                SELECT
                    m.message_id,
                    m.album_parent_id,
                    m.timestamp,
                    (
                        SELECT MAX(sibling.album_index)
                        FROM messages sibling
                        WHERE sibling.album_parent_id = m.album_parent_id
                    ) AS max_index
                FROM messages m
                WHERE m.album_parent_id IS NOT NULL
                  AND m.album_index IS NULL
                  AND ($1::text IS NULL OR m.album_parent_id = $1)
            ) missing
         )
         UPDATE messages
         SET album_index = ranked.album_index
         FROM ranked
         WHERE messages.message_id = ranked.message_id`,
        [parentId ?? null]
    )
}

export async function findRecentAlbumParent(
    groupJid: string,
    senderJid: string | null,
    timestamp: number
): Promise<string | null> {
    const windowStart = timestamp - ALBUM_ASSOCIATION_WINDOW_SECONDS
    const windowEnd = timestamp + ALBUM_ASSOCIATION_WINDOW_SECONDS
    const result = await pool.query<{ message_id: string }>(
        `SELECT message_id
         FROM messages
         WHERE group_jid = $1
           AND sender_jid IS NOT DISTINCT FROM $2
           AND message_type = 'albumMessage'
           AND timestamp BETWEEN to_timestamp($3) AND to_timestamp($4)
         ORDER BY ABS(EXTRACT(EPOCH FROM timestamp) - $5::double precision) ASC, message_id DESC
         LIMIT 1`,
        [groupJid, senderJid, windowStart, windowEnd, timestamp]
    )
    return result.rows[0]?.message_id ?? null
}

function isPersonJid(jid: string): boolean {
    const server = jid.split('@')[1] || ''
    return (
        server === 's.whatsapp.net' ||
        server === 'lid' ||
        server === 'c.us' ||
        server === 'hosted' ||
        server === 'hosted.lid'
    )
}

export async function getAppSetting(key: string): Promise<unknown> {
    const result = await pool.query<{ value: unknown }>(
        `SELECT value FROM app_settings WHERE key = $1`,
        [key]
    )
    return result.rows[0]?.value
}

export async function setAppSetting(key: string, value: unknown): Promise<void> {
    await pool.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, JSON.stringify(value)]
    )
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

export async function upsertSenders(
    entries: Array<{ jid: string; displayName: string }>
): Promise<void> {
    const people = entries.filter((entry) => isPersonJid(entry.jid))
    if (people.length === 0) return
    await pool.query(
        `INSERT INTO senders (jid, display_name, updated_at)
         SELECT jid, NULLIF(name, ''), NOW()
         FROM unnest($1::text[], $2::text[]) AS t(jid, name)
         ON CONFLICT (jid) DO UPDATE SET
            display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), senders.display_name),
            updated_at = NOW()`,
        [people.map((entry) => entry.jid), people.map((entry) => entry.displayName)]
    )
}

export async function upsertSender(jid: string, displayName: string): Promise<void> {
    await upsertSenders([{ jid, displayName }])
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
    albumParentId: string | null
    albumIndex: number | null
    timestamp: number
    isEdited: boolean
    isHistory: boolean
    isForwarded: boolean
}

export async function insertMessage(row: MessageRow): Promise<void> {
    await pool.query(
        `INSERT INTO messages (
            message_id, group_jid, sender_jid, message_secret, message_type,
            text_content, media_path, reply_to_id, quoted_message, album_parent_id,
            album_index, timestamp, is_edited, is_deleted, is_history, is_forwarded
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, to_timestamp($12), $13, FALSE, $14, $15)
         ON CONFLICT (message_id) DO UPDATE SET
            message_secret = COALESCE(messages.message_secret, EXCLUDED.message_secret),
            album_parent_id = COALESCE(EXCLUDED.album_parent_id, messages.album_parent_id),
            album_index = COALESCE(EXCLUDED.album_index, messages.album_index),
            quoted_message = COALESCE(NULLIF(BTRIM(messages.quoted_message), ''), EXCLUDED.quoted_message),
            reply_to_id = COALESCE(messages.reply_to_id, EXCLUDED.reply_to_id),
            is_forwarded = messages.is_forwarded OR EXCLUDED.is_forwarded`,
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
            row.albumParentId,
            row.albumIndex,
            row.timestamp,
            row.isEdited,
            row.isHistory,
            row.isForwarded,
        ]
    )
}

export async function updateAlbumLink(
    messageId: string,
    albumParentId: string | null,
    albumIndex: number | null
): Promise<void> {
    if (!albumParentId && albumIndex == null) return
    await pool.query(
        `UPDATE messages
         SET album_parent_id = COALESCE($2, album_parent_id),
             album_index = COALESCE($3, album_index)
         WHERE message_id = $1`,
        [messageId, albumParentId, albumIndex]
    )
}

export async function updateMessageMediaPath(messageId: string, mediaPath: string): Promise<boolean> {
    const result = await pool.query<{ is_deleted: boolean }>(
        'UPDATE messages SET media_path = $1 WHERE message_id = $2 RETURNING is_deleted',
        [mediaPath, messageId]
    )
    return Boolean(result.rows[0]?.is_deleted)
}

export async function hasMessage(messageId: string): Promise<boolean> {
    const result = await pool.query('SELECT 1 FROM messages WHERE message_id = $1 LIMIT 1', [messageId])
    return (result.rowCount ?? 0) > 0
}

export async function markMessageForwarded(messageId: string): Promise<void> {
    await pool.query(
        `UPDATE messages SET is_forwarded = TRUE WHERE message_id = $1 AND is_forwarded = FALSE`,
        [messageId]
    )
}

export async function getStoredMessageContent(messageId: string): Promise<string | null> {
    const result = await pool.query<{ text_content: string | null }>(
        'SELECT text_content FROM messages WHERE message_id = $1',
        [messageId]
    )
    return result.rows[0]?.text_content ?? null
}

export type LatestGroupMessage = {
    messageId: string
    senderJid: string | null
    timestamp: number
}

async function getGroupMessageAnchor(
    groupJid: string,
    direction: 'latest' | 'oldest'
): Promise<LatestGroupMessage | undefined> {
    const order = direction === 'latest' ? 'DESC' : 'ASC'
    const result = await pool.query<{
        message_id: string
        sender_jid: string | null
        timestamp: string | null
    }>(
        `SELECT
            message_id,
            sender_jid,
            EXTRACT(EPOCH FROM timestamp)::bigint::text AS timestamp
         FROM messages
         WHERE group_jid = $1 AND timestamp IS NOT NULL
         ORDER BY timestamp ${order}, message_id ${order}
         LIMIT 1`,
        [groupJid]
    )
    const row = result.rows[0]
    if (!row?.timestamp) return undefined
    return {
        messageId: row.message_id,
        senderJid: row.sender_jid,
        timestamp: Number(row.timestamp),
    }
}

export async function getLatestGroupMessage(groupJid: string): Promise<LatestGroupMessage | undefined> {
    return getGroupMessageAnchor(groupJid, 'latest')
}

export async function getOldestGroupMessage(groupJid: string): Promise<LatestGroupMessage | undefined> {
    return getGroupMessageAnchor(groupJid, 'oldest')
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

export type MessageEditTarget = {
    messageId: string
    senderJid: string | null
    messageSecret: string | null
}

export async function getMessageEditTarget(messageId: string): Promise<MessageEditTarget | undefined> {
    const result = await pool.query<{
        sender_jid: string | null
        message_secret: string | null
    }>(
        'SELECT sender_jid, message_secret FROM messages WHERE message_id = $1',
        [messageId]
    )
    const row = result.rows[0]
    if (!row) return undefined
    return {
        messageId,
        senderJid: row.sender_jid,
        messageSecret: row.message_secret,
    }
}

export async function fillMessageSecretIfMissing(
    messageId: string,
    messageSecret: string
): Promise<boolean> {
    const result = await pool.query(
        `UPDATE messages
         SET message_secret = $1
         WHERE message_id = $2
           AND (message_secret IS NULL OR message_secret = '')`,
        [messageSecret, messageId]
    )
    return (result.rowCount ?? 0) > 0
}

export async function markMessageEdited(messageId: string, textContent: string): Promise<boolean> {
    const result = await pool.query(
        'UPDATE messages SET text_content = $1, is_edited = TRUE WHERE message_id = $2',
        [textContent, messageId]
    )
    return (result.rowCount ?? 0) > 0
}

export async function markMessagesDeleted(
    messageIds: string[]
): Promise<Array<{ messageId: string; mediaPath: string | null }>> {
    if (messageIds.length === 0) return []
    const result = await pool.query<{ message_id: string; media_path: string | null }>(
        `UPDATE messages SET is_deleted = TRUE
         WHERE message_id = ANY($1::text[])
         RETURNING message_id, media_path`,
        [messageIds]
    )
    return result.rows.map((row) => ({
        messageId: row.message_id,
        mediaPath: row.media_path,
    }))
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
            EXTRACT(EPOCH FROM latest.timestamp)::bigint AS latest_timestamp,
            latest.text_content AS latest_text
         FROM groups g
         LEFT JOIN messages m
           ON m.group_jid = g.jid
          AND m.timestamp >= to_timestamp($1)
          AND m.timestamp < to_timestamp($2)
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
                ELSE regexp_replace(media_path, '^.*[\\\\/]', '')
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
            regexp_replace(media_path, '^.*[\\\\/]', '') AS file_name
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
                ELSE regexp_replace(m.media_path, '^.*[\\\\/]', '')
            END AS file_name
         FROM messages m
         LEFT JOIN senders s ON s.jid = m.sender_jid
         WHERE m.group_jid = $1
           AND m.timestamp >= to_timestamp($2)
           AND m.timestamp < to_timestamp($3)
           AND (
                m.album_parent_id IS NULL
                OR NOT EXISTS (
                    SELECT 1 FROM messages parent WHERE parent.message_id = m.album_parent_id
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
                    ELSE regexp_replace(m.media_path, '^.*[\\\\/]', '')
                END AS file_name,
                m.album_parent_id
             FROM messages m
             LEFT JOIN senders s ON s.jid = m.sender_jid
             WHERE m.album_parent_id = ANY($1::text[])
             ORDER BY m.album_index ASC NULLS LAST, m.timestamp ASC, m.message_id ASC`,
            [albumIds]
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
    cursor?: MessageCursor
): Promise<{ items: AlbumMedia[]; nextCursor: MessageCursor | null }> {
    const allowedJids = await matchingGroupJids()
    const { scopedJids, empty } = resolveAlbumGroupFilter(allowedJids, groupJids)
    if (empty) {
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
            EXTRACT(EPOCH FROM m.timestamp)::bigint AS timestamp,
            regexp_replace(m.media_path, '^.*[\\\\/]', '') AS file_name
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
            regexp_replace(m.media_path, '^.*[\\\\/]', '') AS file_name,
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
