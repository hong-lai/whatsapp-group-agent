import { config as shared, env, envInt, matchesGroupPattern } from '../../../packages/shared/src/config.js'

export { matchesGroupPattern } from '../../../packages/shared/src/config.js'

export const config = {
    ...shared,
    authDir: env('AUTH_DIR', 'auth_info_baileys'),
    historyRequestMinMs: envInt('HISTORY_REQUEST_MIN_MS', 4000),
    historyRequestMaxMs: envInt('HISTORY_REQUEST_MAX_MS', 12000),
    historySettleMinMs: envInt('HISTORY_SETTLE_MIN_MS', 6000),
    historySettleMaxMs: envInt('HISTORY_SETTLE_MAX_MS', 15000),
    mediaDelayMinMs: envInt('MEDIA_DELAY_MIN_MS', 1500),
    mediaDelayMaxMs: envInt('MEDIA_DELAY_MAX_MS', 4000),
    mediaRetryMaxAttempts: envInt('MEDIA_RETRY_MAX_ATTEMPTS', 5),
    mediaRetryMinMs: envInt('MEDIA_RETRY_MIN_MS', 5000),
    mediaRetryMaxMs: envInt('MEDIA_RETRY_MAX_MS', 60_000),
    /** When true, save message rows but skip downloading media files (faster text-only ingest). */
    skipMediaDownload: env('SKIP_MEDIA_DOWNLOAD', 'false') === 'true',
    /** Reconnect catchup: only fill gaps newer than now - this many seconds. */
    catchupWindowSeconds: envInt('CATCHUP_WINDOW_SECONDS', 15 * 60),
    /** First login / deep backfill: keep/fetch at most this many seconds of history. */
    catchupBackfillSeconds: envInt('CATCHUP_BACKFILL_SECONDS', 2 * 24 * 60 * 60),
    catchupPageSize: envInt('CATCHUP_PAGE_SIZE', 50),
    /** Max on-demand pages per group for reconnect window catchup. */
    catchupMaxPages: envInt('CATCHUP_MAX_PAGES', 3),
    /** Max on-demand pages per group for first-login / deep backfill. */
    catchupBackfillMaxPages: envInt('CATCHUP_BACKFILL_MAX_PAGES', 40),
}
