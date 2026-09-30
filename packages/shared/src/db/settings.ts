import { pool } from './pool.js'

const EXHAUSTED_MEDIA_KEY = 'media_download_exhausted_v1'

function exhaustedIds(value: unknown): string[] {
    if (!value || typeof value !== 'object') return []
    const ids = (value as { messageIds?: unknown }).messageIds
    if (!Array.isArray(ids)) return []
    return ids.filter((id): id is string => typeof id === 'string')
}

/** Message ids whose media download has given up. Startup catchup will not page these again. */
export async function listExhaustedMediaDownloadIds(): Promise<string[]> {
    return exhaustedIds(await getAppSetting(EXHAUSTED_MEDIA_KEY))
}

let exhaustChain: Promise<void> = Promise.resolve()

export function noteExhaustedMediaDownload(messageId: string): void {
    exhaustChain = exhaustChain
        .then(async () => {
            const ids = new Set(await listExhaustedMediaDownloadIds())
            if (ids.has(messageId)) return
            ids.add(messageId)
            await setAppSetting(EXHAUSTED_MEDIA_KEY, { messageIds: [...ids] })
        })
        .catch(() => {
            // A missed exhaustion mark only causes another startup history walk.
        })
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
