import { basename, extname } from 'node:path'

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

export function mediaExtension(nameOrPath: string, fallback = 'bin'): string {
    const raw =
        extname(nameOrPath).toLowerCase() ||
        nameOrPath.toLowerCase().match(/(\.[a-z0-9]{1,8})$/)?.[1] ||
        ''
    if (/^\.[a-z0-9]{1,8}$/.test(raw)) return raw
    const clean = fallback
        .replace(/^\./, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 8)
    return `.${clean || 'bin'}`
}

export function fileStem(name: string, fallback: string): string {
    const extension = extname(name)
    const stem = extension ? basename(name, extension) : basename(name)
    return safePathSegment(stem, fallback)
}

export function firstAvailableName(
    preferred: string,
    taken: (candidate: string) => boolean
): string {
    if (!taken(preferred)) return preferred

    const slash = preferred.lastIndexOf('/')
    const dir = slash >= 0 ? preferred.slice(0, slash + 1) : ''
    const name = slash >= 0 ? preferred.slice(slash + 1) : preferred
    const extension = mediaExtension(name)
    const stem = fileStem(name, 'media')
    for (let n = 1; n < 10000; n++) {
        const candidate = `${dir}${stem}_${String(n).padStart(2, '0')}${extension}`
        if (!taken(candidate)) return candidate
    }
    return `${dir}${stem}_dup${extension}`
}

export function hktFilename(
    timestamp: number,
    messageId: string,
    mediaPath: string,
    originalName?: string | null
): string {
    const stamp = hktStamp(timestamp)
    const source = originalName?.trim() || ''
    const extension = mediaExtension(source || mediaPath)
    if (source) {
        return `${stamp.date}_${stamp.time}_${fileStem(source, 'document')}${extension}`
    }
    return `${stamp.date}_${stamp.time}_${safePathSegment(messageId, 'media')}${extension}`
}

export function storedDownloadName(storedPath: string, timestamp: number, messageId: string): string {
    const stored = basename(storedPath)
    if (stored && stored !== '.' && stored !== '..') {
        return stored
    }
    return hktFilename(timestamp, messageId, storedPath)
}

export function uniqueArchivePath(path: string, used: Set<string>): string {
    const unique = firstAvailableName(path, (candidate) => used.has(candidate))
    used.add(unique)
    return unique
}

export function contentDisposition(filename: string, type: 'inline' | 'attachment' = 'inline'): string {
    const ascii =
        filename.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7E]/g, '_').trim() || 'download.bin'
    return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
