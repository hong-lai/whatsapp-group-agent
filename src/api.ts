import { ZipArchive } from 'archiver'
import express, { type NextFunction, type Request, type Response } from 'express'
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { getConnectionStatus } from './connection.js'
import {
    getFilenameFormatSettings,
    parseFilenameFormatSettings,
    saveFilenameFormatSettings,
} from './filenameFormat.js'
import {
    contentDisposition,
    safePathSegment,
    storedDownloadName,
    uniqueArchivePath,
} from './hkt.js'
import { log } from './log.js'
import {
    countAlbumMedia,
    getAlbumMediaForDownload,
    getDashboardMedia,
    groupMatchesPattern,
    listAlbumMedia,
    listDashboardGroups,
    listDashboardMessages,
    type MessageCursor,
} from './db.js'

const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const MEDIA_TYPES = {
    image: 'imageMessage',
    video: 'videoMessage',
    document: 'documentMessage',
    audio: 'audioMessage',
    sticker: 'stickerMessage',
} as const
type MediaCategory = keyof typeof MEDIA_TYPES
const ALL_MEDIA_CATEGORIES = Object.keys(MEDIA_TYPES) as MediaCategory[]

type DateRange = {
    from: string
    to: string
    fromTimestamp: number
    toTimestamp: number
}

function dateStringFromHongKongTime(timestamp = Date.now()): string {
    const shifted = new Date(timestamp + HONG_KONG_OFFSET_MS)
    const year = shifted.getUTCFullYear()
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
    const day = String(shifted.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

function addDays(date: string, days: number): string {
    const timestamp = parseHongKongDate(date)
    return dateStringFromHongKongTime(timestamp * 1000 + days * DAY_MS)
}

function parseHongKongDate(value: string): number {
    const match = DATE_PATTERN.exec(value)
    if (!match) throw new Error(`Invalid date: ${value}`)

    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const utcDate = new Date(Date.UTC(year, month - 1, day))
    if (
        utcDate.getUTCFullYear() !== year ||
        utcDate.getUTCMonth() !== month - 1 ||
        utcDate.getUTCDate() !== day
    ) {
        throw new Error(`Invalid date: ${value}`)
    }

    return Math.floor((utcDate.getTime() - HONG_KONG_OFFSET_MS) / 1000)
}

function getDateRange(request: Request): DateRange {
    const today = dateStringFromHongKongTime()
    const from = typeof request.query.from === 'string' ? request.query.from : addDays(today, -1)
    const to = typeof request.query.to === 'string' ? request.query.to : today
    const fromTimestamp = parseHongKongDate(from)
    const toStartTimestamp = parseHongKongDate(to)
    if (fromTimestamp > toStartTimestamp) {
        throw new Error('The start date must be before or equal to the end date')
    }

    return {
        from,
        to,
        fromTimestamp,
        toTimestamp: toStartTimestamp + DAY_MS / 1000,
    }
}

function encodeCursor(cursor: MessageCursor | null): string | null {
    return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null
}

function decodeCursor(value: unknown): MessageCursor | undefined {
    if (typeof value !== 'string' || !value) return undefined
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<MessageCursor>
        if (
            typeof parsed.timestamp !== 'number' ||
            !Number.isSafeInteger(parsed.timestamp) ||
            typeof parsed.messageId !== 'string' ||
            !parsed.messageId
        ) {
            throw new Error('Invalid cursor')
        }
        return { timestamp: parsed.timestamp, messageId: parsed.messageId }
    } catch {
        throw new Error('Invalid cursor')
    }
}

function parseLimit(value: unknown): number {
    if (typeof value !== 'string') return config.dashboardPageSize
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed) || parsed < 1) throw new Error('Invalid page size')
    return Math.min(parsed, config.dashboardMaxPageSize)
}

function parseAlbumLimit(value: unknown): number {
    if (typeof value !== 'string') return config.albumPageSize
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed) || parsed < 1) throw new Error('Invalid album page size')
    return Math.min(parsed, config.albumMaxPageSize)
}

function parseMediaCategories(value: unknown): MediaCategory[] {
    if (typeof value !== 'string' || !value.trim()) return ALL_MEDIA_CATEGORIES
    const categories = [...new Set(value.split(',').map((item) => item.trim()))]
    if (
        categories.length === 0 ||
        categories.some((category) => !ALL_MEDIA_CATEGORIES.includes(category as MediaCategory))
    ) {
        throw new Error('Invalid media types')
    }
    return categories as MediaCategory[]
}

function parseOptionalGroups(query: Request['query']): string[] | undefined {
    const raw = query.groups ?? query.group
    if (raw === undefined) return undefined
    const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((value) =>
        String(value)
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
    )
    if (parts.some((jid) => !jid.endsWith('@g.us'))) {
        throw new Error('Invalid group')
    }
    return [...new Set(parts)]
}

function getRouteParam(value: string | string[] | undefined): string {
    if (typeof value !== 'string' || !value) throw new Error('Invalid route parameter')
    return value
}

function isWithin(root: string, candidate: string): boolean {
    const pathFromRoot = relative(root, candidate)
    return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function resolveMediaPath(storedPath: string): string | undefined {
    const root = resolve(config.downloadDir)
    let candidate = resolve(storedPath)

    if (!isWithin(root, candidate)) {
        const marker = `${sep}downloads${sep}`
        const markerIndex = storedPath.lastIndexOf(marker)
        if (markerIndex < 0) return undefined
        candidate = resolve(root, storedPath.slice(markerIndex + marker.length))
    }

    return isWithin(root, candidate) ? candidate : undefined
}

function asyncRoute(
    handler: (request: Request, response: Response, next: NextFunction) => Promise<void>
) {
    return (request: Request, response: Response, next: NextFunction) => {
        void handler(request, response, next).catch(next)
    }
}

export function createApiApp() {
    const app = express()
    app.disable('x-powered-by')

    app.get('/api/status', (_request, response) => {
        response.json(getConnectionStatus())
    })

    app.get(
        '/api/groups',
        asyncRoute(async (request, response) => {
            const range = getDateRange(request)
            const groups = await listDashboardGroups(range.fromTimestamp, range.toTimestamp)
            response.json({
                range: { from: range.from, to: range.to },
                pattern: {
                    source: config.groupPatternSource,
                    flags: 'i',
                },
                groups,
            })
        })
    )

    app.get(
        '/api/groups/:jid/messages',
        asyncRoute(async (request, response) => {
            const jid = getRouteParam(request.params.jid)
            if (!(await groupMatchesPattern(jid))) {
                response.status(404).json({ error: 'Group is outside the configured name pattern' })
                return
            }
            const range = getDateRange(request)
            const cursor = decodeCursor(request.query.cursor)
            const limit = parseLimit(request.query.limit)
            const page = await listDashboardMessages(
                jid,
                range.fromTimestamp,
                range.toTimestamp,
                limit,
                cursor
            )
            response.json({
                range: { from: range.from, to: range.to },
                messages: page.messages,
                nextCursor: encodeCursor(page.nextCursor),
            })
        })
    )

    app.get(
        '/api/album',
        asyncRoute(async (request, response) => {
            const range = getDateRange(request)
            const categories = parseMediaCategories(request.query.types)
            const messageTypes = categories.map((category) => MEDIA_TYPES[category])
            const groupJids = parseOptionalGroups(request.query)
            const cursor = decodeCursor(request.query.cursor)
            const limit = parseAlbumLimit(request.query.limit)
            const [page, counts] = await Promise.all([
                listAlbumMedia(
                    range.fromTimestamp,
                    range.toTimestamp,
                    messageTypes,
                    limit,
                    groupJids,
                    cursor
                ),
                countAlbumMedia(range.fromTimestamp, range.toTimestamp, groupJids),
            ])

            response.json({
                range: { from: range.from, to: range.to },
                pattern: {
                    source: config.groupPatternSource,
                    flags: 'i',
                },
                scope: { groupJids: groupJids ?? null },
                types: categories,
                counts,
                items: page.items.map((item) => ({
                    ...item,
                    category: ALL_MEDIA_CATEGORIES.find(
                        (category) => MEDIA_TYPES[category] === item.messageType
                    ),
                    mediaUrl: `/api/media/${encodeURIComponent(item.messageId)}`,
                })),
                nextCursor: encodeCursor(page.nextCursor),
            })
        })
    )

    app.post(
        '/api/album/download',
        express.json({ limit: '64kb' }),
        asyncRoute(async (request, response) => {
            const range = getDateRange(request)
            const categories = parseMediaCategories(request.query.types)
            const messageTypes = categories.map((category) => MEDIA_TYPES[category])
            const groupJids = parseOptionalGroups(request.query)
            const rawMessageIds = (request.body as { messageIds?: unknown } | undefined)?.messageIds
            if (
                !Array.isArray(rawMessageIds) ||
                rawMessageIds.length === 0 ||
                rawMessageIds.some((id) => typeof id !== 'string' || !id)
            ) {
                throw new Error('Invalid or empty media selection')
            }

            const messageIds = [...new Set(rawMessageIds as string[])]
            if (messageIds.length > config.albumMaxBatchSize) {
                response.status(400).json({
                    error: `Select at most ${config.albumMaxBatchSize} media items`,
                })
                return
            }

            const media = await getAlbumMediaForDownload(
                messageIds,
                range.fromTimestamp,
                range.toTimestamp,
                messageTypes,
                groupJids
            )
            if (media.length !== messageIds.length) {
                response.status(400).json({
                    error: 'One or more selected items are missing or outside the active filters',
                })
                return
            }

            const available: Array<(typeof media)[number] & { resolvedPath: string }> = []
            for (const item of media) {
                const resolvedPath = resolveMediaPath(item.mediaPath)
                if (!resolvedPath || !existsSync(resolvedPath)) continue
                if (!(await stat(resolvedPath)).isFile()) continue
                available.push({ ...item, resolvedPath })
            }
            if (available.length === 0) {
                response.status(404).json({ error: 'The selected media files are unavailable' })
                return
            }

            const archiveName = `whatsapp-media_${range.from}_to_${range.to}.zip`
            response.status(200)
            response.setHeader('Content-Type', 'application/zip')
            response.setHeader(
                'Content-Disposition',
                `attachment; filename="${archiveName}"`
            )
            response.setHeader('Cache-Control', 'no-store')

            const archive = new ZipArchive({ zlib: { level: 6 } })
            archive.on('warning', (warning: Error) => {
                log.warn({ err: warning, archiveName }, 'album.archive_warning')
            })
            archive.on('error', (error: Error) => {
                log.error({ err: error, archiveName }, 'album.archive_failed')
                response.destroy(error)
            })
            request.on('aborted', () => archive.abort())
            archive.pipe(response)

            const usedPaths = new Set<string>()
            for (const item of available) {
                const filename = storedDownloadName(
                    item.resolvedPath,
                    item.timestamp,
                    item.messageId
                )
                const archivePath = uniqueArchivePath(
                    groupJids?.length === 1
                        ? filename
                        : `${safePathSegment(item.groupName, item.groupJid)}/${filename}`,
                    usedPaths
                )
                archive.append(createReadStream(item.resolvedPath), { name: archivePath })
            }
            await archive.finalize()
        })
    )

    app.get('/api/settings/filename-format', (_request, response) => {
        response.json(getFilenameFormatSettings())
    })

    app.put(
        '/api/settings/filename-format',
        express.json({ limit: '32kb' }),
        asyncRoute(async (request, response) => {
            const parsed = parseFilenameFormatSettings(request.body)
            const saved = await saveFilenameFormatSettings(parsed)
            response.json(saved)
        })
    )

    app.get(
        '/api/media/:messageId',
        asyncRoute(async (request, response) => {
            const media = await getDashboardMedia(getRouteParam(request.params.messageId))
            if (!media) {
                response.status(404).json({ error: 'Media not found' })
                return
            }

            const mediaPath = resolveMediaPath(media.mediaPath)
            if (!mediaPath || !existsSync(mediaPath) || !(await stat(mediaPath)).isFile()) {
                response.status(404).json({ error: 'Media file not found' })
                return
            }

            response.sendFile(mediaPath, {
                headers: {
                    'Cache-Control': 'private, max-age=3600',
                    'Content-Disposition': contentDisposition(basename(mediaPath)),
                },
            })
        })
    )

    const webDist = fileURLToPath(new URL('../web/dist', import.meta.url))
    if (existsSync(webDist)) {
        app.use(express.static(webDist, { index: false }))
        app.use((request, response, next) => {
            if (!['GET', 'HEAD'].includes(request.method) || request.path.startsWith('/api/')) {
                next()
                return
            }
            response.sendFile(resolve(webDist, 'index.html'))
        })
    }

    app.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
        void next
        const message = error instanceof Error ? error.message : 'Unexpected error'
        const status = message.startsWith('Invalid') || message.includes('date must') ? 400 : 500
        if (status === 500) {
            log.error(
                { err: error, method: request.method, path: request.path },
                'api.error'
            )
        }
        response.status(status).json({ error: status === 500 ? 'Internal server error' : message })
    })

    return app
}

export function startApi(): void {
    createApiApp().listen(config.webPort, '0.0.0.0', () => {
        log.info({ port: config.webPort }, 'dashboard.listening')
    })
}

