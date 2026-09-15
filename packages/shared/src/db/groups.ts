import { matchesGroupPattern } from '../config.js'
import { pool } from './pool.js'

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

export async function matchingGroupJids(): Promise<string[]> {
    const result = await pool.query<{ jid: string; name: string }>('SELECT jid, name FROM groups')
    return result.rows.filter((row) => matchesGroupPattern(row.name)).map((row) => row.jid)
}

export async function groupMatchesPattern(jid: string): Promise<boolean> {
    const result = await pool.query<{ name: string }>('SELECT name FROM groups WHERE jid = $1', [jid])
    return matchesGroupPattern(result.rows[0]?.name)
}
