import express, { type NextFunction, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import {
    getDashboardMedia,
    listDashboardGroups,
    listDashboardMessages,
    type MessageCursor,
} from './db.js'

const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

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
    const from = typeof request.query.from === 'string' ? request.query.from : addDays(today, -6)
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

    app.get(
        '/api/groups',
        asyncRoute(async (request, response) => {
            const range = getDateRange(request)
            const groups = await listDashboardGroups(range.fromTimestamp, range.toTimestamp)
            response.json({ range: { from: range.from, to: range.to }, groups })
        })
    )

    app.get(
        '/api/groups/:jid/messages',
        asyncRoute(async (request, response) => {
            const range = getDateRange(request)
            const cursor = decodeCursor(request.query.cursor)
            const limit = parseLimit(request.query.limit)
            const page = await listDashboardMessages(
                getRouteParam(request.params.jid),
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

            response.setHeader('Cache-Control', 'private, max-age=3600')
            response.sendFile(mediaPath)
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
        void request
        void next
        const message = error instanceof Error ? error.message : 'Unexpected error'
        const status = message.startsWith('Invalid') || message.includes('date must') ? 400 : 500
        if (status === 500) console.error('Dashboard API error:', error)
        response.status(status).json({ error: status === 500 ? 'Internal server error' : message })
    })

    return app
}

export function startApi(): void {
    createApiApp().listen(config.webPort, '0.0.0.0', () => {
        console.log(`Dashboard available at http://localhost:${config.webPort}`)
    })
}

