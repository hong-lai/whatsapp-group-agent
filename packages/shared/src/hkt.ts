const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000

export type HktParts = {
    date: string
    time: string
}

/** Calendar date / clock parts in Asia/Hong_Kong for a unix-seconds or ms timestamp. */
export function hktParts(timestamp: number, unit: 'seconds' | 'ms' = 'seconds'): HktParts {
    const ms = unit === 'ms' ? timestamp : timestamp * 1000
    const date = new Date(ms + HONG_KONG_OFFSET_MS)
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    const day = String(date.getUTCDate()).padStart(2, '0')
    const hour = date.getUTCHours()
    const minute = date.getUTCMinutes()
    const second = date.getUTCSeconds()
    return {
        date: `${year}-${month}-${day}`,
        time: [
            String(hour).padStart(2, '0'),
            String(minute).padStart(2, '0'),
            String(second).padStart(2, '0'),
        ].join('-'),
    }
}

/** Today's calendar date in Asia/Hong_Kong (`YYYY-MM-DD`). */
export function hktToday(nowMs = Date.now()): string {
    return hktParts(nowMs, 'ms').date
}

export function hktStamp(timestamp: number): { date: string; time: string } {
    const parts = hktParts(timestamp, 'seconds')
    return { date: parts.date, time: parts.time }
}
