import { log } from '../log.js'
import { pool } from './pool.js'
import { getAppSetting, setAppSetting } from './settings.js'

// History sync often strips messageAssociation. Nearby attach is only a history
// fallback: group within a short burst of the album itself, never across another
// album from the same sender. Live children must use native parentMessageKey.
const ALBUM_BURST_GAP_SECONDS = 10
const ALBUM_ASSOCIATION_WINDOW_SECONDS = 30
const ALBUM_MEDIA_TYPES = ['imageMessage', 'videoMessage', 'ptvMessage'] as const
const ALBUM_PARENTS_BACKFILL_KEY = 'album_parents_backfilled'
const ALBUM_BURST_UNLINK_KEY = 'album_burst_unlinked_v1'
const ALBUM_EXPECTED_ZERO_KEY = 'album_expected_zero_nulled_v1'
const ALBUM_ORPHAN_REATTACH_KEY = 'album_orphan_reattach_v2'

function isAlbumVideoType(messageType: string): boolean {
    return messageType === 'videoMessage' || messageType === 'ptvMessage'
}

function isAlbumMediaType(messageType: string): boolean {
    return messageType === 'imageMessage' || isAlbumVideoType(messageType)
}

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

export async function migrateAlbumParents(): Promise<void> {
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

    if (!(await getAppSetting(ALBUM_ORPHAN_REATTACH_KEY))) {
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
            if (!Number.isFinite(asEpochSeconds(album.timestamp))) continue
            attached += await attachNearbyAlbumMedia({
                parentId: album.message_id,
                groupJid: album.group_jid,
                senderJid: album.sender_jid,
                timestamp: asEpochSeconds(album.timestamp),
                expectedImages: album.album_expected_images,
                expectedVideos: album.album_expected_videos,
            })
        }
        await setAppSetting(ALBUM_ORPHAN_REATTACH_KEY, {
            albums: albums.rowCount ?? 0,
            attached,
            at: Date.now(),
        })
        if (attached > 0) {
            log.info(
                { albums: albums.rowCount ?? 0, attached },
                'db.album_orphans_reattached'
            )
        }
        await fillMissingAlbumIndexes()
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
    const videos = children.filter((child) => isAlbumVideoType(child.messageType)).length
    const imageLimit = album.expectedImages ?? 0
    const videoLimit = album.expectedVideos ?? 0
    if (isAlbumVideoType(messageType)) return videos < videoLimit
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
        const isVideo = isAlbumVideoType(item.messageType)
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
    candidate: AlbumCandidate,
    options: { requireBurst?: boolean } = {}
): boolean {
    if (!albumSlotsRemaining(album, children, candidate.messageType)) return false
    // Explicit parentMessageKey is authoritative — do not drop it on delivery lag.
    if (options.requireBurst === false) return true
    // When WhatsApp told us the slot counts, pick by distance within the window
    // rather than requiring a tight delivery burst (children often land 3–10s later).
    if (expectedKnown(album)) {
        return pickAlbumMembers([...children, candidate], album).some(
            (item) => item.messageId === candidate.messageId
        )
    }
    const burst = albumBurst([...children, candidate], album.timestamp)
    return burst.some((item) => item.messageId === candidate.messageId)
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
    const memberPool = [...existing, ...nearby]
    const selected = expectedKnown(album)
        ? pickAlbumMembers(memberPool, album)
        : pickAlbumMembers(albumBurst(memberPool, album.timestamp), album)
    const keep = new Set(selected.map((item) => item.messageId))
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
        // Native parentMessageKey — trust it; do not apply delivery-burst filters.
        return params.explicitParentId
    }
    // Nearby matching is only a history-sync fallback (association is often stripped).
    if (!params.isHistory || !isAlbumMediaType(params.messageType)) {
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
