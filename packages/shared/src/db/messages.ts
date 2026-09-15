import { hktStamp } from '../hkt.js'
import { pool } from './pool.js'

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
    albumExpectedImages?: number | null
    albumExpectedVideos?: number | null
    timestamp: number
    isEdited: boolean
    isHistory: boolean
    isForwarded: boolean
    fileName?: string | null
}

export async function insertMessage(row: MessageRow): Promise<void> {
    await pool.query(
        `INSERT INTO messages (
            message_id, group_jid, sender_jid, message_secret, message_type,
            text_content, media_path, file_name, reply_to_id, quoted_message, album_parent_id,
            album_index, album_expected_images, album_expected_videos,
            timestamp, is_edited, is_deleted, is_history, is_forwarded
         ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
            to_timestamp($15), $16, FALSE, $17, $18
         )
         ON CONFLICT (message_id) DO UPDATE SET
            message_secret = COALESCE(messages.message_secret, EXCLUDED.message_secret),
            file_name = COALESCE(messages.file_name, EXCLUDED.file_name),
            album_parent_id = COALESCE(EXCLUDED.album_parent_id, messages.album_parent_id),
            album_index = COALESCE(EXCLUDED.album_index, messages.album_index),
            album_expected_images = COALESCE(
                NULLIF(EXCLUDED.album_expected_images, 0),
                NULLIF(messages.album_expected_images, 0)
            ),
            album_expected_videos = COALESCE(
                NULLIF(EXCLUDED.album_expected_videos, 0),
                NULLIF(messages.album_expected_videos, 0)
            ),
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
            row.fileName ?? null,
            row.replyToId,
            row.quotedMessage,
            row.albumParentId,
            row.albumIndex,
            row.albumExpectedImages ?? null,
            row.albumExpectedVideos ?? null,
            row.timestamp,
            row.isEdited,
            row.isHistory,
            row.isForwarded,
        ]
    )
}

export async function updateAlbumExpected(
    messageId: string,
    expectedImages: number | null,
    expectedVideos: number | null
): Promise<void> {
    if (
        (expectedImages == null || expectedImages <= 0) &&
        (expectedVideos == null || expectedVideos <= 0)
    ) {
        return
    }
    await pool.query(
        `UPDATE messages
         SET album_expected_images = COALESCE(NULLIF($2, 0), album_expected_images),
             album_expected_videos = COALESCE(NULLIF($3, 0), album_expected_videos)
         WHERE message_id = $1 AND message_type = 'albumMessage'`,
        [messageId, expectedImages, expectedVideos]
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

/** Media download state for an existing row. `undefined` if the message is unknown. */
export async function getMessageMediaState(
    messageId: string
): Promise<{ mediaPath: string | null; isDeleted: boolean } | undefined> {
    const result = await pool.query<{ media_path: string | null; is_deleted: boolean }>(
        'SELECT media_path, is_deleted FROM messages WHERE message_id = $1',
        [messageId]
    )
    const row = result.rows[0]
    if (!row) return undefined
    return { mediaPath: row.media_path, isDeleted: row.is_deleted }
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

/** Message calendar date in Asia/Hong_Kong (`YYYY-MM-DD`), or null if missing. */
export async function getMessageHktDate(messageId: string): Promise<string | null> {
    const result = await pool.query<{ timestamp: string | null }>(
        `SELECT EXTRACT(EPOCH FROM timestamp)::bigint::text AS timestamp
         FROM messages
         WHERE message_id = $1
         LIMIT 1`,
        [messageId]
    )
    const raw = result.rows[0]?.timestamp
    if (raw == null) return null
    const epoch = Number(raw)
    if (!Number.isFinite(epoch)) return null
    return hktStamp(epoch).date
}

/** Fields Baileys needs via `getMessage` for retries and encrypted edit unwrap. */
export async function getStoredMessageForGetMessage(
    messageId: string
): Promise<{ text: string | null; messageSecret: string | null } | undefined> {
    const result = await pool.query<{
        text_content: string | null
        message_secret: string | null
    }>(
        'SELECT text_content, message_secret FROM messages WHERE message_id = $1',
        [messageId]
    )
    const row = result.rows[0]
    if (!row) return undefined
    return {
        text: row.text_content,
        messageSecret: row.message_secret,
    }
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
