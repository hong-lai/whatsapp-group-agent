import { extname } from 'node:path'

const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000

export function safePathSegment(value: string, fallback: string): string {
    const sanitized = value
        .normalize('NFKC')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/\.+$/g, '')
        .trim()
        .slice(0, 100)
    return sanitized || fallback
}

export function hktStamp(timestamp: number): { date: string; time: string } {
    const date = new Date(timestamp * 1000 + HONG_KONG_OFFSET_MS)
    const parts = [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
    ]
    const time = [
        String(date.getUTCHours()).padStart(2, '0'),
        String(date.getUTCMinutes()).padStart(2, '0'),
        String(date.getUTCSeconds()).padStart(2, '0'),
    ]
    return { date: parts.join('-'), time: time.join('-') }
}

export function hktFilename(timestamp: number, messageId: string, mediaPath: string): string {
    const stamp = hktStamp(timestamp)
    const rawExtension = extname(mediaPath).toLowerCase() || mediaPath.toLowerCase().match(/(\.[a-z0-9]{1,8})$/)?.[1] || ''
    const extension = /^\.[a-z0-9]{1,8}$/.test(rawExtension) ? rawExtension : '.bin'
    return `${stamp.date}_${stamp.time}_${safePathSegment(messageId, 'media')}${extension}`
}
