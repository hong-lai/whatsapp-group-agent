function env(name: string, fallback: string): string {
    return process.env[name] || fallback
}

function envInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : fallback
}

export const config = {
    databaseUrl: env('DATABASE_URL', 'postgres://whatsapp:whatsapp@localhost:5432/whatsapp'),
    redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
    groupPattern: new RegExp(env('GROUP_PATTERN', '富山邨|錦田'), 'i'),
    authDir: env('AUTH_DIR', 'auth_info_baileys'),
    downloadDir: env('DOWNLOAD_DIR', './downloads'),
    historyDelayMinMs: envInt('HISTORY_DELAY_MIN_MS', 800),
    historyDelayMaxMs: envInt('HISTORY_DELAY_MAX_MS', 2000),
    mediaDelayMinMs: envInt('MEDIA_DELAY_MIN_MS', 1500),
    mediaDelayMaxMs: envInt('MEDIA_DELAY_MAX_MS', 4000),
}

export function matchesGroupPattern(name: string | undefined | null): boolean {
    return Boolean(name && config.groupPattern.test(name))
}
