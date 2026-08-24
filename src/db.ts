import { Pool } from 'pg'
import { config } from './config.js'

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
    `)
        console.log('Postgres schema ready')
    } catch (err) {
        const e = err as { code?: string }
        if (e.code === '28000') {
            console.error(
                'Postgres has no matching role. Use `docker compose up` (the app service), or copy .env.example to .env so DATABASE_URL points at Compose Postgres on localhost:5433.'
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
