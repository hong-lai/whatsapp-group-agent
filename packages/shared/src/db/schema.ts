import { log } from '../log.js'
import { migrateAlbumParents } from './albums.js'
import { DASHBOARD_HIDDEN_MESSAGE_TYPES } from './sql.js'
import { pool } from './pool.js'
import { getAppSetting, setAppSetting } from './settings.js'

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
        await migrateDocumentFileName()
        await migrateWorkflowTables()

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
        const hidden = await pool.query(
            `DELETE FROM messages WHERE message_type = ANY($1::text[])`,
            [[...DASHBOARD_HIDDEN_MESSAGE_TYPES]]
        )
        if (hidden.rowCount) {
            log.info(
                { count: hidden.rowCount, types: DASHBOARD_HIDDEN_MESSAGE_TYPES },
                'db.hidden_message_types_removed'
            )
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
async function migrateForwarded(): Promise<void> {
    await pool.query(
        `ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_forwarded BOOLEAN NOT NULL DEFAULT FALSE`
    )
}

async function migrateQuotedMessageType(): Promise<void> {
    await pool.query(`ALTER TABLE messages DROP COLUMN IF EXISTS quoted_message_type`)
}

const DOCUMENT_FILE_NAME_BACKFILL_KEY = 'document_file_names_backfilled'
async function migrateDocumentFileName(): Promise<void> {
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_name TEXT`)
    if (await getAppSetting(DOCUMENT_FILE_NAME_BACKFILL_KEY)) return

    const result = await pool.query(
        `UPDATE messages
         SET file_name = NULLIF(
                regexp_replace(
                    regexp_replace(media_path, '^.*[\\\\/]', ''),
                    '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}_',
                    ''
                ),
                ''
            )
         WHERE message_type = 'documentMessage'
           AND media_path IS NOT NULL
           AND file_name IS NULL`
    )
    await setAppSetting(DOCUMENT_FILE_NAME_BACKFILL_KEY, {
        count: result.rowCount ?? 0,
        at: Date.now(),
    })
    if (result.rowCount) {
        log.info({ count: result.rowCount }, 'db.document_file_names_backfilled')
    }
}

async function migrateWorkflowTables(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS workflow_runs (
            id BIGSERIAL PRIMARY KEY,
            workflow_name TEXT NOT NULL,
            message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
            event TEXT NOT NULL,
            status TEXT NOT NULL,
            detail TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS workflow_runs_message_idx
            ON workflow_runs (message_id, workflow_name, created_at DESC);

        CREATE TABLE IF NOT EXISTS daily_site_reports (
            id BIGSERIAL PRIMARY KEY,
            message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id) ON DELETE CASCADE,
            group_jid TEXT NOT NULL REFERENCES groups(jid),
            report_date DATE,
            po_number TEXT,
            ref_numbers TEXT[] NOT NULL DEFAULT '{}',
            contractor TEXT,
            project_name TEXT,
            rss TEXT,
            workers TEXT[] NOT NULL DEFAULT '{}',
            num_workers INTEGER,
            actual_num_workers INTEGER,
            valid_num_workers BOOLEAN,
            work_scopes TEXT[] NOT NULL DEFAULT '{}',
            trench_length DOUBLE PRECISION NOT NULL DEFAULT 0,
            coring_length DOUBLE PRECISION NOT NULL DEFAULT 0,
            cable_pulling_length DOUBLE PRECISION NOT NULL DEFAULT 0,
            conduit_laying_length DOUBLE PRECISION NOT NULL DEFAULT 0,
            trial_pit_count INTEGER NOT NULL DEFAULT 0,
            remarks TEXT,
            source_text TEXT,
            is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS daily_site_reports_date_po_idx
            ON daily_site_reports (report_date, po_number)
            WHERE is_deleted = FALSE;

        CREATE INDEX IF NOT EXISTS daily_site_reports_group_date_id_idx
            ON daily_site_reports (group_jid, report_date DESC, id DESC)
            WHERE is_deleted = FALSE;

        CREATE INDEX IF NOT EXISTS daily_site_reports_created_id_idx
            ON daily_site_reports (created_at DESC, id DESC)
            WHERE is_deleted = FALSE;
    `)
}
