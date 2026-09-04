import { Pool } from 'pg'
import { config, matchesGroupPattern } from './config.js'
import { hktStamp } from './hkt.js'
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

// History sync often strips messageAssociation. Group only within a short burst of
// the album itself, and never across another album from the same sender. Live
// children carry parentMessageKey; do not absorb a later standalone photo just
// because it arrived a few minutes after an album.
const ALBUM_BURST_GAP_SECONDS = 2
const ALBUM_ASSOCIATION_WINDOW_SECONDS = 30
const ALBUM_MEDIA_TYPES = ['imageMessage', 'videoMessage'] as const
const ALBUM_PARENTS_BACKFILL_KEY = 'album_parents_backfilled'
const ALBUM_BURST_UNLINK_KEY = 'album_burst_unlinked_v1'
const ALBUM_EXPECTED_ZERO_KEY = 'album_expected_zero_nulled_v1'

type AlbumCandidate = {
    messageId: string
    messageType: string
    timestamp: number
}

type AlbumMeta = {
    messageId: string
    timestamp: number
    expectedImages: number | null
    expectedVideos: number | null
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

const FILE_NAME_SQL = `COALESCE(
                NULLIF(BTRIM(m.file_name), ''),
                regexp_replace(m.media_path, '^.*[\\\\/]', '')
            )`

const FILE_NAME_SQL_BARE = `COALESCE(
                NULLIF(BTRIM(file_name), ''),
                regexp_replace(media_path, '^.*[\\\\/]', '')
            )`

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

function likeContainsPattern(query: string): string {
    return `%${query.replace(/[\\%_]/g, '\\$&')}%`
}

async function migrateAlbumParents(): Promise<void> {
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS album_parent_id TEXT`)
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS album_index INTEGER`)
    await pool.query(
        `ALTER TABLE messages ADD COLUMN IF NOT EXISTS album_expected_images INTEGER`
    )
    await pool.query(
        `ALTER TABLE messages ADD COLUMN IF NOT EXISTS album_expected_videos INTEGER`
    )

    if (!(await getAppSetting(ALBUM_PARENTS_BACKFILL_KEY))) {
        const linked = await pool.query(
            `SELECT 1 FROM messages WHERE album_parent_id IS NOT NULL LIMIT 1`
        )
        if ((linked.rowCount ?? 0) > 0) {
            await setAppSetting(ALBUM_PARENTS_BACKFILL_KEY, true)
        } else {
            const albums = await pool.query<{
                message_id: string
                group_jid: string
                sender_jid: string | null
                timestamp: string
                album_expected_images: number | null
                album_expected_videos: number | null
            }>(
                `SELECT
                    message_id,
                    group_jid,
                    sender_jid,
                    EXTRACT(EPOCH FROM timestamp)::bigint::text AS timestamp,
                    album_expected_images,
                    album_expected_videos
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
                    expectedImages: album.album_expected_images,
                    expectedVideos: album.album_expected_videos,
                })
            }
            if (attached > 0) {
                log.info({ albums: albums.rowCount, attached }, 'db.album_parents_backfilled')
            }
            await setAppSetting(ALBUM_PARENTS_BACKFILL_KEY, true)
        }
        await fillMissingAlbumIndexes()
    }

    if (!(await getAppSetting(ALBUM_BURST_UNLINK_KEY))) {
        const unlinked = await unlinkAlbumMediaOutsideBurst()
        await setAppSetting(ALBUM_BURST_UNLINK_KEY, { count: unlinked, at: Date.now() })
        if (unlinked > 0) {
            log.info({ unlinked }, 'db.album_burst_unlinked')
        }
    }

    if (!(await getAppSetting(ALBUM_EXPECTED_ZERO_KEY))) {
        const nulled = await pool.query<{
            message_id: string
            group_jid: string
            sender_jid: string | null
            timestamp: string
            album_expected_images: number | null
            album_expected_videos: number | null
        }>(
            `UPDATE messages
             SET album_expected_images = NULLIF(album_expected_images, 0),
                 album_expected_videos = NULLIF(album_expected_videos, 0)
             WHERE message_type = 'albumMessage'
               AND (album_expected_images = 0 OR album_expected_videos = 0)
             RETURNING
                message_id,
                group_jid,
                sender_jid,
                EXTRACT(EPOCH FROM timestamp)::bigint::text AS timestamp,
                album_expected_images,
                album_expected_videos`
        )
        let attached = 0
        for (const album of nulled.rows) {
            if (album.album_expected_images != null || album.album_expected_videos != null) continue
            if (!Number.isFinite(Number(album.timestamp))) continue
            attached += await attachNearbyAlbumMedia({
                parentId: album.message_id,
                groupJid: album.group_jid,
                senderJid: album.sender_jid,
                timestamp: Number(album.timestamp),
                expectedImages: null,
                expectedVideos: null,
            })
        }
        await setAppSetting(ALBUM_EXPECTED_ZERO_KEY, {
            nulled: nulled.rowCount ?? 0,
            attached,
            at: Date.now(),
        })
        if ((nulled.rowCount ?? 0) > 0 || attached > 0) {
            log.info(
                { nulled: nulled.rowCount ?? 0, attached },
                'db.album_expected_zeros_nulled'
            )
        }
    }
}

function asEpochSeconds(value: string | number | null | undefined): number {
    return Number(value)
}

function albumBurst(
    items: AlbumCandidate[],
    centerTs: number,
    gapSeconds = ALBUM_BURST_GAP_SECONDS
): AlbumCandidate[] {
    if (items.length === 0) return []
    const kept = new Set<string>()
    for (const item of items) {
        if (Math.abs(item.timestamp - centerTs) <= gapSeconds) kept.add(item.messageId)
    }
    if (kept.size === 0) return []
    let changed = true
    while (changed) {
        changed = false
        for (const item of items) {
            if (kept.has(item.messageId)) continue
            for (const other of items) {
                if (!kept.has(other.messageId)) continue
                if (Math.abs(item.timestamp - other.timestamp) <= gapSeconds) {
                    kept.add(item.messageId)
                    changed = true
                    break
                }
            }
        }
    }
    return items.filter((item) => kept.has(item.messageId))
}

function expectedKnown(album: Pick<AlbumMeta, 'expectedImages' | 'expectedVideos'>): boolean {
    return (album.expectedImages != null && album.expectedImages > 0)
        || (album.expectedVideos != null && album.expectedVideos > 0)
}

function albumSlotsRemaining(
    album: Pick<AlbumMeta, 'expectedImages' | 'expectedVideos'>,
    children: AlbumCandidate[],
    messageType: string
): boolean {
    if (!expectedKnown(album)) return true
    const images = children.filter((child) => child.messageType === 'imageMessage').length
    const videos = children.filter((child) => child.messageType === 'videoMessage').length
    const imageLimit = album.expectedImages ?? 0
    const videoLimit = album.expectedVideos ?? 0
    if (messageType === 'videoMessage') return videos < videoLimit
    return images < imageLimit
}

function pickAlbumMembers(
    burst: AlbumCandidate[],
    album: AlbumMeta
): AlbumCandidate[] {
    const byDistance = [...burst].sort((left, right) => {
        const delta =
            Math.abs(left.timestamp - album.timestamp) - Math.abs(right.timestamp - album.timestamp)
        if (delta !== 0) return delta
        return left.messageId.localeCompare(right.messageId)
    })
    if (!expectedKnown(album)) return byDistance
    const imageLimit = album.expectedImages ?? 0
    const videoLimit = album.expectedVideos ?? 0
    const picked: AlbumCandidate[] = []
    let images = 0
    let videos = 0
    for (const item of byDistance) {
        const isVideo = item.messageType === 'videoMessage'
        if (isVideo) {
            if (videos >= videoLimit) continue
            videos += 1
        } else {
            if (images >= imageLimit) continue
            images += 1
        }
        picked.push(item)
    }
    return picked
}

function mediaFitsAlbum(
    album: AlbumMeta,
    children: AlbumCandidate[],
    candidate: AlbumCandidate
): boolean {
    if (!albumSlotsRemaining(album, children, candidate.messageType)) return false
    const burst = albumBurst([...children, candidate], album.timestamp)
    if (!burst.some((item) => item.messageId === candidate.messageId)) return false
    if (!expectedKnown(album)) return true
    return pickAlbumMembers(burst, album).some((item) => item.messageId === candidate.messageId)
}

async function loadAlbumMeta(parentId: string): Promise<AlbumMeta | null> {
    const result = await pool.query<{
        message_id: string
        timestamp: string
        album_expected_images: number | null
        album_expected_videos: number | null
    }>(
        `SELECT
            message_id,
            EXTRACT(EPOCH FROM timestamp)::bigint::text AS timestamp,
            album_expected_images,
            album_expected_videos
         FROM messages
         WHERE message_id = $1 AND message_type = 'albumMessage'`,
        [parentId]
    )
    const row = result.rows[0]
    if (!row || !Number.isFinite(asEpochSeconds(row.timestamp))) return null
    return {
        messageId: row.message_id,
        timestamp: asEpochSeconds(row.timestamp),
        expectedImages: row.album_expected_images,
        expectedVideos: row.album_expected_videos,
    }
}

async function loadAlbumChildren(parentId: string): Promise<AlbumCandidate[]> {
    const result = await pool.query<{
        message_id: string
        message_type: string
        timestamp: string
    }>(
        `SELECT
            message_id,
            message_type,
            EXTRACT(EPOCH FROM timestamp)::bigint::text AS timestamp
         FROM messages
         WHERE album_parent_id = $1`,
        [parentId]
    )
    return result.rows
        .filter((row) => Number.isFinite(asEpochSeconds(row.timestamp)))
        .map((row) => ({
            messageId: row.message_id,
            messageType: row.message_type,
            timestamp: asEpochSeconds(row.timestamp),
        }))
}

async function clearAlbumLinks(messageIds: string[]): Promise<number> {
    if (messageIds.length === 0) return 0
    const result = await pool.query(
        `UPDATE messages
         SET album_parent_id = NULL, album_index = NULL
         WHERE message_id = ANY($1::text[])`,
        [messageIds]
    )
    return result.rowCount ?? 0
}

export async function clearAlbumLink(messageId: string): Promise<void> {
    await clearAlbumLinks([messageId])
}

async function unlinkAlbumMediaOutsideBurst(): Promise<number> {
    const result = await pool.query<{ message_id: string }>(
        `WITH RECURSIVE burst AS (
            SELECT
                child.message_id,
                child.timestamp,
                child.album_parent_id
            FROM messages child
            JOIN messages parent ON parent.message_id = child.album_parent_id
            WHERE parent.message_type = 'albumMessage'
              AND child.album_parent_id IS NOT NULL
              AND child.timestamp IS NOT NULL
              AND parent.timestamp IS NOT NULL
              AND ABS(EXTRACT(EPOCH FROM child.timestamp) - EXTRACT(EPOCH FROM parent.timestamp))
                  <= $1
            UNION
            SELECT
                sibling.message_id,
                sibling.timestamp,
                sibling.album_parent_id
            FROM messages sibling
            JOIN burst ON burst.album_parent_id = sibling.album_parent_id
            WHERE sibling.timestamp IS NOT NULL
              AND ABS(EXTRACT(EPOCH FROM sibling.timestamp) - EXTRACT(EPOCH FROM burst.timestamp))
                  <= $1
         )
         UPDATE messages
         SET album_parent_id = NULL, album_index = NULL
         WHERE album_parent_id IS NOT NULL
           AND message_id NOT IN (SELECT message_id FROM burst)
           AND EXISTS (
                SELECT 1
                FROM messages parent
                WHERE parent.message_id = messages.album_parent_id
                  AND parent.message_type = 'albumMessage'
           )
         RETURNING message_id`,
        [ALBUM_BURST_GAP_SECONDS]
    )
    return result.rowCount ?? 0
}

export async function attachNearbyAlbumMedia(row: {
    parentId: string
    groupJid: string
    senderJid: string | null
    timestamp: number
    expectedImages?: number | null
    expectedVideos?: number | null
}): Promise<number> {
    const album: AlbumMeta = {
        messageId: row.parentId,
        timestamp: row.timestamp,
        expectedImages: row.expectedImages ?? null,
        expectedVideos: row.expectedVideos ?? null,
    }
    const windowStart = row.timestamp - ALBUM_ASSOCIATION_WINDOW_SECONDS
    const windowEnd = row.timestamp + ALBUM_ASSOCIATION_WINDOW_SECONDS
    const existing = await loadAlbumChildren(row.parentId)
    const candidates = await pool.query<{
        message_id: string
        message_type: string
        timestamp: string
    }>(
        `SELECT
            message_id,
            message_type,
            EXTRACT(EPOCH FROM timestamp)::bigint::text AS timestamp
         FROM messages
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
    const nearby = candidates.rows
        .filter((item) => Number.isFinite(asEpochSeconds(item.timestamp)))
        .map((item) => ({
            messageId: item.message_id,
            messageType: item.message_type,
            timestamp: asEpochSeconds(item.timestamp),
        }))
    const burst = albumBurst([...existing, ...nearby], album.timestamp)
    const keep = new Set(pickAlbumMembers(burst, album).map((item) => item.messageId))
    const attachIds = nearby
        .filter((item) => keep.has(item.messageId))
        .map((item) => item.messageId)
    const dropIds = existing
        .filter((item) => !keep.has(item.messageId))
        .map((item) => item.messageId)

    let attached = 0
    if (attachIds.length > 0) {
        const result = await pool.query(
            `UPDATE messages SET album_parent_id = $1
             WHERE message_id = ANY($2::text[]) AND album_parent_id IS NULL`,
            [row.parentId, attachIds]
        )
        attached = result.rowCount ?? 0
    }
    if (dropIds.length > 0) await clearAlbumLinks(dropIds)
    if (attached > 0) await fillMissingAlbumIndexes(row.parentId)
    return attached
}

export async function resolveAlbumParent(params: {
    groupJid: string
    senderJid: string | null
    timestamp: number
    messageType: string
    explicitParentId: string | null
    isHistory: boolean
}): Promise<string | null> {
    const candidate: AlbumCandidate = {
        messageId: '__candidate__',
        messageType: params.messageType,
        timestamp: params.timestamp,
    }
    if (params.explicitParentId) {
        const album = await loadAlbumMeta(params.explicitParentId)
        if (!album) return params.explicitParentId
        const children = await loadAlbumChildren(params.explicitParentId)
        return mediaFitsAlbum(album, children, candidate) ? params.explicitParentId : null
    }
    if (!params.isHistory) return null
    if (
        params.messageType !== 'imageMessage' &&
        params.messageType !== 'videoMessage'
    ) {
        return null
    }

    const windowStart = params.timestamp - ALBUM_ASSOCIATION_WINDOW_SECONDS
    const windowEnd = params.timestamp + ALBUM_ASSOCIATION_WINDOW_SECONDS
    const albums = await pool.query<{
        message_id: string
        timestamp: string
        album_expected_images: number | null
        album_expected_videos: number | null
    }>(
        `SELECT
            message_id,
            EXTRACT(EPOCH FROM timestamp)::bigint::text AS timestamp,
            album_expected_images,
            album_expected_videos
         FROM messages
         WHERE group_jid = $1
           AND sender_jid IS NOT DISTINCT FROM $2
           AND message_type = 'albumMessage'
           AND timestamp BETWEEN to_timestamp($3) AND to_timestamp($4)
         ORDER BY ABS(EXTRACT(EPOCH FROM timestamp) - $5::double precision) ASC, message_id DESC`,
        [params.groupJid, params.senderJid, windowStart, windowEnd, params.timestamp]
    )
    for (const row of albums.rows) {
        if (!Number.isFinite(asEpochSeconds(row.timestamp))) continue
        const album: AlbumMeta = {
            messageId: row.message_id,
            timestamp: asEpochSeconds(row.timestamp),
            expectedImages: row.album_expected_images,
            expectedVideos: row.album_expected_videos,
        }
        const children = await loadAlbumChildren(album.messageId)
        if (mediaFitsAlbum(album, children, candidate)) return album.messageId
    }
    return null
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
    siteReportExtracted: boolean
    siteReportFailed: boolean
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
    site_report_extracted: boolean
    site_report_workflow_status: string | null
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
        siteReportExtracted: row.site_report_extracted,
        siteReportFailed:
            !row.site_report_extracted && row.site_report_workflow_status === 'error',
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
            ) AS site_report_workflow_status
         FROM messages m
         LEFT JOIN senders s ON s.jid = m.sender_jid
         WHERE m.group_jid = $1
           AND m.timestamp >= to_timestamp($2)
           AND m.timestamp < to_timestamp($3)
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
                ) AS site_report_workflow_status
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

export type DailySiteReportDateField = 'report' | 'created'

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

export function defaultDailySiteReportSort(
    dateField: DailySiteReportDateField
): { sortBy: DailySiteReportSortBy; sortDir: DailySiteReportSortDir } {
    return dateField === 'created'
        ? { sortBy: 'createdAt', sortDir: 'desc' }
        : { sortBy: 'reportDate', sortDir: 'desc' }
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
    id: number
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
        id: row.id,
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
    const dateFilterSql =
        dateField === 'created'
            ? `(r.created_at AT TIME ZONE 'Asia/Hong_Kong')::date >= $1::date
               AND (r.created_at AT TIME ZONE 'Asia/Hong_Kong')::date <= $2::date`
            : `r.report_date >= $1::date AND r.report_date <= $2::date`
    const orderSql = `${sortSpec.sql} ${sortDir.toUpperCase()} NULLS LAST, r.id ${sortDir.toUpperCase()}`

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
                      id: last.id,
                  }
                : null,
        total: Number(countResult.rows[0]?.count ?? 0),
    }
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
    const dateFilterSql =
        dateField === 'created'
            ? `(r.created_at AT TIME ZONE 'Asia/Hong_Kong')::date >= $1::date
               AND (r.created_at AT TIME ZONE 'Asia/Hong_Kong')::date <= $2::date`
            : `r.report_date >= $1::date AND r.report_date <= $2::date`
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
             WHERE ${whereSql}`,
            params
        ),
        pool.query<{ message_id: string }>(
            `SELECT r.message_id
             FROM daily_site_reports r
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
    const dateExpr =
        dateField === 'created'
            ? `(r.created_at AT TIME ZONE 'Asia/Hong_Kong')::date`
            : `r.report_date`
    const dateFilterSql =
        dateField === 'created'
            ? `${dateExpr} >= $1::date AND ${dateExpr} <= $2::date`
            : `r.report_date >= $1::date AND r.report_date <= $2::date`
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

export async function deleteDailySiteReport(
    id: number
): Promise<{ groupJid: string; reportDate: string | null } | null> {
    const result = await pool.query<{ group_jid: string; report_date: string | null }>(
        `DELETE FROM daily_site_reports
         WHERE id = $1
         RETURNING group_jid, report_date::text`,
        [id]
    )
    const row = result.rows[0]
    if (!row) return null
    return { groupJid: row.group_jid, reportDate: row.report_date }
}

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
