import { existsSync, readFileSync } from 'node:fs'

function loadDotEnv(): void {
    if (!existsSync('.env')) return
    const text = readFileSync('.env', 'utf8')
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq < 0) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1)
        }
        if (process.env[key] === undefined) process.env[key] = value
    }
}

loadDotEnv()

function env(name: string, fallback: string): string {
    return process.env[name] || fallback
}

function envInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : fallback
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

function envLogLevel(name: string, fallback: LogLevel): LogLevel {
    const raw = (process.env[name] || '').toLowerCase()
    if (raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug') return raw
    return fallback
}

const GROUP_PATTERN_SOURCE = env('GROUP_PATTERN', '富山邨|錦田')

export const config = {
    databaseUrl: env('DATABASE_URL', 'postgres://whatsapp:whatsapp@localhost:5433/whatsapp'),
    redisUrl: env('REDIS_URL', 'redis://localhost:6380'),
    webPort: envInt('WEB_PORT', 3000),
    dashboardPageSize: envInt('DASHBOARD_PAGE_SIZE', 50),
    dashboardMaxPageSize: envInt('DASHBOARD_MAX_PAGE_SIZE', 100),
    albumPageSize: envInt('ALBUM_PAGE_SIZE', 60),
    albumMaxPageSize: envInt('ALBUM_MAX_PAGE_SIZE', 120),
    albumMaxBatchSize: envInt('ALBUM_MAX_BATCH_SIZE', 500),
    groupPatternSource: GROUP_PATTERN_SOURCE,
    groupPattern: new RegExp(GROUP_PATTERN_SOURCE, 'i'),
    authDir: env('AUTH_DIR', 'auth_info_baileys'),
    downloadDir: env('DOWNLOAD_DIR', './downloads'),
    historyRequestMinMs: envInt('HISTORY_REQUEST_MIN_MS', 4000),
    historyRequestMaxMs: envInt('HISTORY_REQUEST_MAX_MS', 12000),
    historySettleMinMs: envInt('HISTORY_SETTLE_MIN_MS', 6000),
    historySettleMaxMs: envInt('HISTORY_SETTLE_MAX_MS', 15000),
    mediaDelayMinMs: envInt('MEDIA_DELAY_MIN_MS', 1500),
    mediaDelayMaxMs: envInt('MEDIA_DELAY_MAX_MS', 4000),
    catchupWindowSeconds: envInt('CATCHUP_WINDOW_SECONDS', 15 * 60),
    catchupPageSize: envInt('CATCHUP_PAGE_SIZE', 50),
    catchupMaxPages: envInt('CATCHUP_MAX_PAGES', 3),
    logLevel: envLogLevel('LOG_LEVEL', 'info'),
}

export function matchesGroupPattern(name: string | undefined | null): boolean {
    return Boolean(name && config.groupPattern.test(name))
}
