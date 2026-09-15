import 'dotenv/config'

export function env(name: string, fallback: string): string {
    return process.env[name] || fallback
}

export function envInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : fallback
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export function envLogLevel(name: string, fallback: LogLevel): LogLevel {
    const raw = (process.env[name] || '').toLowerCase()
    if (raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug') return raw
    return fallback
}

function parseCsvNames(raw: string): string[] {
    return [
        ...new Set(
            raw
                .split(',')
                .map((part) => part.trim())
                .filter(Boolean)
        ),
    ].sort((a, b) => a.localeCompare(b))
}

/** Keep in sync with agent_workflows/registry.py `_AVAILABLE`. */
export const AVAILABLE_WORKFLOW_NAMES = ['daily_site_report'] as const

export const WORKFLOW_LABELS: Record<string, string> = {
    daily_site_report: 'Daily site report',
}

const GROUP_PATTERN_SOURCE = env('GROUP_PATTERN', '富山邨|錦田')

export const config = {
    databaseUrl: env('DATABASE_URL', 'postgres://whatsapp:whatsapp@localhost:5433/whatsapp'),
    redisUrl: env('REDIS_URL', 'redis://localhost:6380'),
    groupPatternSource: GROUP_PATTERN_SOURCE,
    groupPattern: new RegExp(GROUP_PATTERN_SOURCE, 'i'),
    downloadDir: env('DOWNLOAD_DIR', './downloads'),
    logLevel: envLogLevel('LOG_LEVEL', 'info'),
    /** Enqueue message events for external Python workflow workers (BullMQ). */
    workflowsEnabled: env('WORKFLOWS_ENABLED', 'false') === 'true',
    /** When false, history/catch-up messages are not enqueued (avoids LLM floods). */
    workflowsProcessHistory: env('WORKFLOWS_PROCESS_HISTORY', 'false') === 'true',
    /**
     * Workflows the Python worker may run (comma-separated).
     * Must stay aligned with agent_workflows/registry.py + ENABLED_WORKFLOWS.
     */
    enabledWorkflows: parseCsvNames(env('ENABLED_WORKFLOWS', 'daily_site_report')),
    /**
     * All registered workflow names (Node-side mirror of registry._AVAILABLE).
     * Used for admin listing / validation; enablement is still ENABLED_WORKFLOWS.
     */
    availableWorkflows: [...AVAILABLE_WORKFLOW_NAMES],
    /** Shared with workflows worker — used by debug UI for model listing / defaults. */
    llmBaseUrl: env('LLM_BASE_URL', 'http://localhost:1234/v1'),
    llmApiKey: env('LLM_API_KEY', '1234'),
    llmModel: env('LLM_MODEL', 'google/gemma-4-e2b'),
    /** Prompt files for daily_site_report (read-only for debug UI). */
    dailySiteReportPromptsDir: env(
        'DAILY_SITE_REPORT_PROMPTS_DIR',
        './services/workflows/private/daily_site_report'
    ),
}

export function matchesGroupPattern(name: string | undefined | null): boolean {
    return Boolean(name && config.groupPattern.test(name))
}
