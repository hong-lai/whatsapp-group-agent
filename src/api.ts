import { ZipArchive } from 'archiver'
import express, { type NextFunction, type Request, type Response } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
    listDailySiteReports,
    listDailySiteReportsForExport,
    listDailySiteReportMessageIds,
    listDailySiteReportMetricsSeries,
    deleteDailySiteReport,
    defaultDailySiteReportSort,
    isDailySiteReportSortBy,
    getWorkflowDebugSnapshot,
    getMessageForWorkflowEnqueue,
    getMessagesForWorkflowEnqueue,
    type DailySiteReportCursor,
    type DailySiteReportDateField,
    type DailySiteReportSortBy,
    type DailySiteReportSortDir,
    type MessageCursor,
} from './db.js'
import { enqueueMessageEvent } from './queue/index.js'
import type { MessageEventType } from './queue/types.js'

const ROBOTS_TAG = 'noindex, nofollow, noarchive, nosnippet, noimageindex'
const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n'
const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

async function listLlmModels(): Promise<string[]> {
    const base = config.llmBaseUrl.replace(/\/+$/, '')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    try {
        const response = await fetch(`${base}/models`, {
            headers: {
                Authorization: `Bearer ${config.llmApiKey}`,
            },
            signal: controller.signal,
        })
        if (!response.ok) return []
        const body = (await response.json()) as { data?: Array<{ id?: unknown }> }
        if (!Array.isArray(body.data)) return []
        const ids = body.data
            .map((item) => (typeof item.id === 'string' ? item.id.trim() : ''))
            .filter(Boolean)
        return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
    } catch {
        return []
    } finally {
        clearTimeout(timer)
    }
}

function readPromptFile(fileName: string): string | null {
    const dir = resolve(config.dailySiteReportPromptsDir)
    const path = join(dir, fileName)
    if (!existsSync(path)) return null
    try {
        return readFileSync(path, 'utf8')
    } catch {
        return null
    }
}

function readWorkflowPrompts(): {
    classifierPrompt: string | null
    extractorPrompt: string | null
    promptsDir: string
} {
    return {
        classifierPrompt: readPromptFile('classifier_prompt.txt'),
        extractorPrompt: readPromptFile('extractor_prompt.txt'),
        promptsDir: resolve(config.dailySiteReportPromptsDir),
    }
}

function optionalPromptOverride(value: unknown, maxChars = 50_000): string | null {
    if (typeof value !== 'string') return null
    if (!value.trim()) return null
    if (value.length > maxChars) {
        throw new Error(`Prompt exceeds ${maxChars} characters`)
    }
    return value
}
const MEDIA_TYPES = {
    image: ['imageMessage'],
    video: ['videoMessage', 'ptvMessage'],
    document: ['documentMessage'],
    audio: ['audioMessage'],
    sticker: ['stickerMessage'],
} as const
type MediaCategory = keyof typeof MEDIA_TYPES
const ALL_MEDIA_CATEGORIES = Object.keys(MEDIA_TYPES) as MediaCategory[]

function mediaCategoryForType(messageType: string): MediaCategory | undefined {
    return ALL_MEDIA_CATEGORIES.find((category) =>
        (MEDIA_TYPES[category] as readonly string[]).includes(messageType)
    )
}

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
    return parseDateRangeValues(request.query.from, request.query.to)
}

function parseDateRangeValues(fromValue: unknown, toValue: unknown): DateRange {
    const today = dateStringFromHongKongTime()
    const from = typeof fromValue === 'string' && fromValue ? fromValue : today
    const to = typeof toValue === 'string' && toValue ? toValue : today
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

function decodeReportCursor(value: unknown): DailySiteReportCursor | undefined {
    if (typeof value !== 'string' || !value) return undefined
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<DailySiteReportCursor>
        if (typeof parsed.id !== 'number' || !Number.isSafeInteger(parsed.id)) {
            throw new Error('Invalid cursor')
        }
        if (!isDailySiteReportSortBy(parsed.sortBy)) {
            throw new Error('Invalid cursor')
        }
        if (parsed.sortDir !== 'asc' && parsed.sortDir !== 'desc') {
            throw new Error('Invalid cursor')
        }
        if (
            parsed.sortValue !== null &&
            typeof parsed.sortValue !== 'string' &&
            typeof parsed.sortValue !== 'number'
        ) {
            throw new Error('Invalid cursor')
        }
        return {
            sortBy: parsed.sortBy,
            sortDir: parsed.sortDir,
            sortValue: parsed.sortValue ?? null,
            id: parsed.id,
        }
    } catch {
        throw new Error('Invalid cursor')
    }
}

function parseReportDateField(value: unknown): DailySiteReportDateField {
    return value === 'created' ? 'created' : 'report'
}

function parseReportSort(
    sortByValue: unknown,
    sortDirValue: unknown,
    dateField: DailySiteReportDateField
): { sortBy: DailySiteReportSortBy; sortDir: DailySiteReportSortDir } {
    const defaults = defaultDailySiteReportSort(dateField)
    const sortBy = isDailySiteReportSortBy(sortByValue) ? sortByValue : defaults.sortBy
    const sortDir: DailySiteReportSortDir =
        sortDirValue === 'asc' || sortDirValue === 'desc' ? sortDirValue : defaults.sortDir
    return { sortBy, sortDir }
}

function encodeReportCursor(cursor: DailySiteReportCursor | null): string | null {
    return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null
}

import { buildDailySiteReportsCsv } from './reportsCsv.js'

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

function parseFileNameQuery(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed || undefined
}

function albumMessageTypes(categories: MediaCategory[], fileNameQuery?: string): string[] {
    if (fileNameQuery) return [...MEDIA_TYPES.document]
    return categories.flatMap((category) => MEDIA_TYPES[category])
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

function adminPasswordMatches(provided: string | undefined): boolean {
    const expected = Buffer.from(config.adminPassword)
    const actual = Buffer.from(provided ?? '')
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
}

function requireAdmin(request: Request, response: Response, next: NextFunction): void {
    if (!adminPasswordMatches(request.get('x-admin-password'))) {
        response.status(401).json({ error: 'Invalid password' })
        return
    }
    next()
}

export function createApiApp() {
    const app = express()
    app.disable('x-powered-by')

    app.use((_request, response, next) => {
        response.setHeader('X-Robots-Tag', ROBOTS_TAG)
        response.setHeader('Referrer-Policy', 'no-referrer')
        next()
    })

    app.get('/robots.txt', (_request, response) => {
        response
            .type('text/plain; charset=utf-8')
            .setHeader('Cache-Control', 'no-cache')
            .send(ROBOTS_TXT)
    })

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
            const fileNameQuery = parseFileNameQuery(request.query.q)
            const categories = parseMediaCategories(request.query.types)
            const messageTypes = albumMessageTypes(categories, fileNameQuery)
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
                    cursor,
                    fileNameQuery
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
                    category: mediaCategoryForType(item.messageType),
                    mediaUrl: `/api/media/${encodeURIComponent(item.messageId)}`,
                })),
                nextCursor: encodeCursor(page.nextCursor),
            })
        })
    )

    app.get(
        '/api/daily-site-reports',
        asyncRoute(async (request, response) => {
            const range = getDateRange(request)
            const groupJid =
                typeof request.query.group === 'string' && request.query.group
                    ? request.query.group
                    : undefined
            if (groupJid && !groupJid.endsWith('@g.us')) {
                throw new Error('Invalid group')
            }
            const query = parseFileNameQuery(request.query.q)
            const dateField = parseReportDateField(request.query.dateField)
            const { sortBy, sortDir } = parseReportSort(
                request.query.sortBy,
                request.query.sortDir,
                dateField
            )
            const cursor = decodeReportCursor(request.query.cursor)
            const limit = parseLimit(request.query.limit)
            const page = await listDailySiteReports({
                fromDate: range.from,
                toDate: range.to,
                dateField,
                sortBy,
                sortDir,
                limit,
                ...(groupJid ? { groupJid } : {}),
                ...(query ? { query } : {}),
                ...(cursor ? { cursor } : {}),
            })
            response.json({
                range: { from: range.from, to: range.to },
                dateField,
                sortBy,
                sortDir,
                total: page.total,
                reports: page.reports,
                nextCursor: encodeReportCursor(page.nextCursor),
            })
        })
    )

    app.get(
        '/api/daily-site-reports/export.csv',
        asyncRoute(async (request, response) => {
            const range = getDateRange(request)
            const groupJid =
                typeof request.query.group === 'string' && request.query.group
                    ? request.query.group
                    : undefined
            if (groupJid && !groupJid.endsWith('@g.us')) {
                throw new Error('Invalid group')
            }
            const query = parseFileNameQuery(request.query.q)
            const dateField = parseReportDateField(request.query.dateField)
            const { sortBy, sortDir } = parseReportSort(
                request.query.sortBy,
                request.query.sortDir,
                dateField
            )
            const reports = await listDailySiteReportsForExport({
                fromDate: range.from,
                toDate: range.to,
                dateField,
                sortBy,
                sortDir,
                maxRows: 5000,
                ...(groupJid ? { groupJid } : {}),
                ...(query ? { query } : {}),
            })

            const filename = `daily_site_reports_${range.from}_to_${range.to}.csv`
            response
                .status(200)
                .type('text/csv; charset=utf-8')
                .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
                .setHeader('Cache-Control', 'no-store')
                .send(buildDailySiteReportsCsv(reports))
        })
    )

    app.get(
        '/api/daily-site-reports/metrics-series',
        asyncRoute(async (request, response) => {
            const range = getDateRange(request)
            const groupJid =
                typeof request.query.group === 'string' && request.query.group
                    ? request.query.group
                    : undefined
            if (groupJid && !groupJid.endsWith('@g.us')) {
                throw new Error('Invalid group')
            }
            const query = parseFileNameQuery(request.query.q)
            const dateField = parseReportDateField(request.query.dateField)
            const points = await listDailySiteReportMetricsSeries({
                fromDate: range.from,
                toDate: range.to,
                dateField,
                ...(groupJid ? { groupJid } : {}),
                ...(query ? { query } : {}),
            })
            response.json({
                range: { from: range.from, to: range.to },
                dateField,
                points,
            })
        })
    )

    app.delete(
        '/api/daily-site-reports/:id',
        requireAdmin,
        asyncRoute(async (request, response) => {
            const id = Number.parseInt(String(request.params.id), 10)
            if (!Number.isSafeInteger(id) || id < 1) {
                throw new Error('Invalid report id')
            }
            const deleted = await deleteDailySiteReport(id)
            if (!deleted) {
                response.status(404).json({ error: 'Report not found' })
                return
            }
            response.json({ ok: true })
        })
    )

    app.get(
        '/api/debug/workflows',
        requireAdmin,
        asyncRoute(async (request, response) => {
            const messageId =
                typeof request.query.messageId === 'string' ? request.query.messageId.trim() : ''
            if (!messageId) throw new Error('messageId is required')
            const limitRaw =
                typeof request.query.limit === 'string'
                    ? Number.parseInt(request.query.limit, 10)
                    : 20
            const limit = Number.isFinite(limitRaw) ? limitRaw : 20
            const snapshot = await getWorkflowDebugSnapshot(messageId, limit)
            if (!snapshot) {
                response.status(404).json({ error: 'Message not found' })
                return
            }
            const models = await listLlmModels()
            const defaultModel = config.llmModel
            const modelOptions = models.includes(defaultModel)
                ? models
                : [defaultModel, ...models]
            const prompts = readWorkflowPrompts()
            response.json({
                workflowsEnabled: config.workflowsEnabled,
                workflowsProcessHistory: config.workflowsProcessHistory,
                defaultModel,
                models: modelOptions,
                prompts,
                snapshot,
            })
        })
    )

    app.post(
        '/api/debug/workflows/reenqueue',
        requireAdmin,
        express.json({ limit: '256kb' }),
        asyncRoute(async (request, response) => {
            if (!config.workflowsEnabled) {
                response.status(503).json({ error: 'Workflows are disabled (WORKFLOWS_ENABLED=false)' })
                return
            }
            const body = (request.body ?? {}) as {
                messageId?: unknown
                llmModel?: unknown
                classifierPrompt?: unknown
                extractorPrompt?: unknown
            }
            const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : ''
            if (!messageId) throw new Error('messageId is required')

            const llmModel =
                typeof body.llmModel === 'string' && body.llmModel.trim()
                    ? body.llmModel.trim()
                    : config.llmModel
            const classifierPrompt = optionalPromptOverride(body.classifierPrompt)
            const extractorPrompt = optionalPromptOverride(body.extractorPrompt)

            const message = await getMessageForWorkflowEnqueue(messageId)
            if (!message) {
                response.status(404).json({ error: 'Message not found' })
                return
            }

            const event: MessageEventType = message.isEdited
                ? 'message.edited'
                : 'message.created'

            const enqueued = await enqueueMessageEvent({
                event,
                messageId: message.messageId,
                groupJid: message.groupJid,
                messageType: message.messageType,
                mediaPath: message.mediaPath,
                isHistory: false,
                llmModel,
                classifierPrompt,
                extractorPrompt,
            })
            if (!enqueued) {
                response.status(503).json({ error: 'Failed to enqueue workflow job' })
                return
            }

            log.info(
                {
                    messageId: message.messageId,
                    event,
                    llmModel,
                    groupJid: message.groupJid,
                    classifierPromptOverride: Boolean(classifierPrompt),
                    extractorPromptOverride: Boolean(extractorPrompt),
                },
                'workflow.debug_reenqueued'
            )
            response.json({
                ok: true,
                event,
                llmModel,
                messageId: message.messageId,
                groupJid: message.groupJid,
                messageType: message.messageType,
                classifierPromptOverride: Boolean(classifierPrompt),
                extractorPromptOverride: Boolean(extractorPrompt),
            })
        })
    )

    app.post(
        '/api/debug/workflows/reenqueue-filtered',
        requireAdmin,
        express.json({ limit: '256kb' }),
        asyncRoute(async (request, response) => {
            if (!config.workflowsEnabled) {
                response.status(503).json({ error: 'Workflows are disabled (WORKFLOWS_ENABLED=false)' })
                return
            }

            const body = (request.body ?? {}) as {
                from?: unknown
                to?: unknown
                group?: unknown
                q?: unknown
                dateField?: unknown
                llmModel?: unknown
                classifierPrompt?: unknown
                extractorPrompt?: unknown
                maxRows?: unknown
            }

            const range = parseDateRangeValues(body.from, body.to)
            const groupJid =
                typeof body.group === 'string' && body.group.trim() ? body.group.trim() : undefined
            if (groupJid && !groupJid.endsWith('@g.us')) {
                throw new Error('Invalid group')
            }
            const query = parseFileNameQuery(body.q)
            const dateField = parseReportDateField(body.dateField)
            const maxRowsRaw =
                typeof body.maxRows === 'number'
                    ? body.maxRows
                    : typeof body.maxRows === 'string'
                      ? Number.parseInt(body.maxRows, 10)
                      : 500
            const maxRows = Number.isFinite(maxRowsRaw)
                ? Math.min(Math.max(1, Math.floor(maxRowsRaw)), 500)
                : 500

            const llmModel =
                typeof body.llmModel === 'string' && body.llmModel.trim()
                    ? body.llmModel.trim()
                    : config.llmModel
            const classifierPrompt = optionalPromptOverride(body.classifierPrompt)
            const extractorPrompt = optionalPromptOverride(body.extractorPrompt)

            const { messageIds, total } = await listDailySiteReportMessageIds({
                fromDate: range.from,
                toDate: range.to,
                dateField,
                maxRows,
                ...(groupJid ? { groupJid } : {}),
                ...(query ? { query } : {}),
            })

            if (total === 0) {
                response.status(404).json({ error: 'No reports match the selected filters' })
                return
            }
            if (total > maxRows) {
                response.status(400).json({
                    error: `Too many reports (${total}). Narrow filters to at most ${maxRows}.`,
                    total,
                    maxRows,
                })
                return
            }

            const messages = await getMessagesForWorkflowEnqueue(messageIds)
            const foundIds = new Set(messages.map((item) => item.messageId))
            const missing = messageIds.filter((id) => !foundIds.has(id))

            let enqueued = 0
            const failed: string[] = []
            for (const message of messages) {
                const event: MessageEventType = message.isEdited
                    ? 'message.edited'
                    : 'message.created'
                const ok = await enqueueMessageEvent({
                    event,
                    messageId: message.messageId,
                    groupJid: message.groupJid,
                    messageType: message.messageType,
                    mediaPath: message.mediaPath,
                    isHistory: false,
                    llmModel,
                    classifierPrompt,
                    extractorPrompt,
                })
                if (ok) enqueued += 1
                else failed.push(message.messageId)
            }

            log.info(
                {
                    from: range.from,
                    to: range.to,
                    dateField,
                    groupJid: groupJid ?? null,
                    query: query ?? null,
                    total,
                    enqueued,
                    failed: failed.length,
                    missing: missing.length,
                    llmModel,
                },
                'workflow.debug_reenqueued_filtered'
            )

            response.json({
                ok: true,
                total,
                enqueued,
                failed,
                missing,
                llmModel,
                range: { from: range.from, to: range.to },
                dateField,
                groupJid: groupJid ?? null,
                query: query ?? null,
            })
        })
    )

    app.post(
        '/api/album/download',
        express.json({ limit: '64kb' }),
        asyncRoute(async (request, response) => {
            const range = getDateRange(request)
            const fileNameQuery = parseFileNameQuery(request.query.q)
            const categories = parseMediaCategories(request.query.types)
            const messageTypes = albumMessageTypes(categories, fileNameQuery)
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

    app.get(
        '/api/settings/filename-format',
        requireAdmin,
        asyncRoute(async (_request, response) => {
            response.json(await getFilenameFormatSettings())
        })
    )

    app.put(
        '/api/settings/filename-format',
        requireAdmin,
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
        app.use(
            express.static(webDist, {
                index: false,
                setHeaders(response, filePath) {
                    if (filePath.endsWith(`${sep}sw.js`) || filePath.endsWith('.webmanifest')) {
                        response.setHeader('Cache-Control', 'no-cache')
                    }
                },
            })
        )
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

