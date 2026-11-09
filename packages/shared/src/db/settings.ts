import { pool } from './pool.js'

const EXHAUSTED_MEDIA_KEY = 'media_download_exhausted_v1'
const KEPT_AFTER_FAILED_MEDIA_KEY = 'media_keep_after_failed_download_v1'

function exhaustedIds(value: unknown): string[] {
    if (!value || typeof value !== 'object') return []
    const ids = (value as { messageIds?: unknown }).messageIds
    if (!Array.isArray(ids)) return []
    return ids.filter((id): id is string => typeof id === 'string')
}

/** Message ids whose media download has given up. A restart will not page these again. */
export async function listExhaustedMediaDownloadIds(): Promise<string[]> {
    return exhaustedIds(await getAppSetting(EXHAUSTED_MEDIA_KEY))
}

/**
 * Ids whose own file download failed. Recorded before the database write
 * finishes, so a delete event cannot remove the message in that gap.
 * A history walk that never reaches a file does not keep it.
 */
const keptAfterMediaFailure = new Set<string>()
const releasedAfterMediaSuccess = new Set<string>()
const keepRevision = new Map<string, number>()
let keepLoad: Promise<void> | undefined
let keepLoaded = false

async function listKeptAfterFailedMedia(): Promise<string[]> {
    return exhaustedIds(await getAppSetting(KEPT_AFTER_FAILED_MEDIA_KEY))
}

function ensureKeepLoaded(): Promise<void> {
    keepLoad ??= listKeptAfterFailedMedia()
        .then((ids) => {
            for (const id of ids) {
                if (releasedAfterMediaSuccess.has(id)) continue
                keptAfterMediaFailure.add(id)
            }
            keepLoaded = true
        })
        .catch((err) => {
            keepLoad = undefined
            throw err
        })
    return keepLoad
}

function bumpKeepRevision(messageId: string): number {
    const revision = (keepRevision.get(messageId) ?? 0) + 1
    keepRevision.set(messageId, revision)
    return revision
}

export async function shouldKeepMessageAfterFailedMedia(messageId: string): Promise<boolean> {
    if (releasedAfterMediaSuccess.has(messageId)) return false
    if (keptAfterMediaFailure.has(messageId)) return true
    await ensureKeepLoaded()
    if (releasedAfterMediaSuccess.has(messageId)) return false
    if (keptAfterMediaFailure.has(messageId)) return true
    return false
}

let exhaustChain: Promise<void> = Promise.resolve()
let keepChain: Promise<void> = Promise.resolve()

function rememberKeptAfterFailedMedia(messageId: string): void {
    releasedAfterMediaSuccess.delete(messageId)
    keptAfterMediaFailure.add(messageId)
    const revision = bumpKeepRevision(messageId)
    keepChain = keepChain
        .then(async () => {
            await ensureKeepLoaded()
            if (keepRevision.get(messageId) !== revision) return
            keptAfterMediaFailure.add(messageId)
            await setAppSetting(KEPT_AFTER_FAILED_MEDIA_KEY, { messageIds: [...keptAfterMediaFailure] })
        })
        .catch(() => {
            // The in-memory set still blocks a delete until this process exits.
        })
}

/** The file was saved, so a delete that waited on the download can apply. */
export function releaseFailedMediaDownload(messageId: string): Promise<void> {
    if (keepLoaded && !keptAfterMediaFailure.has(messageId)) return Promise.resolve()
    const revision = bumpKeepRevision(messageId)
    const run = keepChain.then(async () => {
        await ensureKeepLoaded()
        if (keepRevision.get(messageId) !== revision) return
        if (!keptAfterMediaFailure.has(messageId)) return
        keptAfterMediaFailure.delete(messageId)
        releasedAfterMediaSuccess.add(messageId)
        await setAppSetting(KEPT_AFTER_FAILED_MEDIA_KEY, { messageIds: [...keptAfterMediaFailure] })
    })
    keepChain = run.then(
        () => undefined,
        () => undefined
    )
    return run
}

/** The download itself failed. Keep the row even if WhatsApp then sends a delete. */
export function noteFailedMediaDownload(messageId: string): void {
    rememberKeptAfterFailedMedia(messageId)
}

/**
 * Drop these ids from the given-up list. An admin retry walks the files again.
 * Serialized with noteExhaustedMediaDownload so a late failure cannot restore them.
 */
export function releaseExhaustedMediaDownloads(messageIds: readonly string[]): Promise<number> {
    const drop = new Set(messageIds.filter((id) => id.length > 0))
    if (drop.size === 0) return Promise.resolve(0)
    const run = exhaustChain.then(async () => {
        const ids = new Set(await listExhaustedMediaDownloadIds())
        let released = 0
        for (const id of drop) {
            if (!ids.delete(id)) continue
            released += 1
        }
        if (released === 0) return 0
        await setAppSetting(EXHAUSTED_MEDIA_KEY, { messageIds: [...ids] })
        return released
    })
    exhaustChain = run.then(
        () => undefined,
        () => undefined
    )
    return run
}

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
