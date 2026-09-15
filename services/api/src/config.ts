import { config as shared, env, envInt } from '../../../packages/shared/src/config.js'

export {
    AVAILABLE_WORKFLOW_NAMES,
    WORKFLOW_LABELS,
    matchesGroupPattern,
} from '../../../packages/shared/src/config.js'

export const config = {
    ...shared,
    webPort: envInt('WEB_PORT', 3000),
    dashboardPageSize: envInt('DASHBOARD_PAGE_SIZE', 50),
    dashboardMaxPageSize: envInt('DASHBOARD_MAX_PAGE_SIZE', 100),
    albumPageSize: envInt('ALBUM_PAGE_SIZE', 60),
    albumMaxPageSize: envInt('ALBUM_MAX_PAGE_SIZE', 120),
    albumMaxBatchSize: envInt('ALBUM_MAX_BATCH_SIZE', 500),
    adminPassword: env('ADMIN_PASSWORD', 'laiwaihong'),
    /** On-disk daily site report CSV root (`{dir}/{messageDate}/daily_site_report.csv`). */
    reportsDir: env('REPORTS_DIR', './reports'),
    /** Debounce before writing today's message-day CSV after the last report change. */
    dailySiteReportFileDebounceMs: envInt('DAILY_SITE_REPORT_FILE_DEBOUNCE_MS', 30_000),
}
