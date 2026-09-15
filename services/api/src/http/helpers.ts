import type { NextFunction, Request, Response } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { config } from '../config.js'
import {
    defaultDailySiteReportSort,
    findInProgressWorkflows,
    isDailySiteReportSortBy,
    recordWorkflowRun,
    type DailySiteReportCursor,
    type DailySiteReportDateField,
    type DailySiteReportSortBy,
    type DailySiteReportSortDir,
    type MessageCursor,
} from '../../../../packages/shared/src/db/index.js'

export const ROBOTS_TAG = 'noindex, nofollow, noarchive, nosnippet, noimageindex'
export const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n'
const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export async function listLlmModels(): Promise<string[]> {
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

export function readPromptFile(fileName: string): string | null {
    const dir = resolve(config.dailySiteReportPromptsDir)
    const path = join(dir, fileName)
    if (!existsSync(path)) return null
    try {
        return readFileSync(path, 'utf8')
    } catch {
        return null
    }
}

export function readWorkflowPrompts(): {
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

export function optionalPromptOverride(value: unknown, maxChars = 50_000): string | null {
    if (typeof value !== 'string') return null
    if (!value.trim()) return null
    if (value.length > maxChars) {
        throw new Error(`Prompt exceeds ${maxChars} characters`)
    }
    return value
}

/** Parse optional workflowNames; undefined = run all enabled. Empty array is invalid. */
export function parseWorkflowNames(value: unknown): string[] | undefined {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) {
        throw new Error('workflowNames must be an array of workflow name strings')
    }
    const names = [
        ...new Set(
            value
                .map((item) => (typeof item === 'string' ? item.trim() : ''))
                .filter(Boolean)
        ),
    ]
    if (names.length === 0) {
        throw new Error('Select at least one workflow')
    }
    const available = new Set<string>(config.availableWorkflows)
    const enabled = new Set<string>(config.enabledWorkflows)
    const unknown = names.filter((name) => !available.has(name))
    if (unknown.length > 0) {
        throw new Error(`Unknown workflow(s): ${unknown.join(', ')}`)
    }
    const disabled = names.filter((name) => !enabled.has(name))
    if (disabled.length > 0) {
        throw new Error(`Workflow(s) not enabled: ${disabled.join(', ')}`)
    }
    return names.sort((a, b) => a.localeCompare(b))
}

export function resolveTargetWorkflowNames(workflowNames: string[] | undefined): string[] {
    return workflowNames ?? [...config.enabledWorkflows]
}

export async function rejectIfWorkflowsInProgress(
    response: Response,
    messageId: string,
    targetWorkflows: string[]
): Promise<boolean> {
    const inProgress = await findInProgressWorkflows(messageId, targetWorkflows)
    if (inProgress.length === 0) return false
    response.status(409).json({
        error: `Workflow already in progress: ${inProgress
            .map((row) => `${row.workflowName} (${row.status})`)
            .join(', ')}`,
        inProgress: inProgress.map((row) => ({
            workflowName: row.workflowName,
            status: row.status,
            detail: row.detail,
        })),
    })
    return true
}

export async function markWorkflowsQueued(params: {
    messageId: string
    event: string
    workflowNames: string[]
}): Promise<void> {
    for (const workflowName of params.workflowNames) {
        await recordWorkflowRun({
            workflowName,
            messageId: params.messageId,
            event: params.event,
            status: 'queued',
            detail: 'Waiting for worker',
        })
    }
}
export const MEDIA_TYPES = {
    image: ['imageMessage'],
    video: ['videoMessage', 'ptvMessage'],
    document: ['documentMessage'],
    audio: ['audioMessage'],
    sticker: ['stickerMessage'],
} as const
export type MediaCategory = keyof typeof MEDIA_TYPES
export const ALL_MEDIA_CATEGORIES = Object.keys(MEDIA_TYPES) as MediaCategory[]

export function mediaCategoryForType(messageType: string): MediaCategory | undefined {
    return ALL_MEDIA_CATEGORIES.find((category) =>
        (MEDIA_TYPES[category] as readonly string[]).includes(messageType)
    )
}

export type DateRange = {
    from: string
    to: string
    fromTimestamp: number
    toTimestamp: number
}

export function dateStringFromHongKongTime(timestamp = Date.now()): string {
    const shifted = new Date(timestamp + HONG_KONG_OFFSET_MS)
    const year = shifted.getUTCFullYear()
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
    const day = String(shifted.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

export function parseHongKongDate(value: string): number {
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

export function getDateRange(request: Request): DateRange {
    return parseDateRangeValues(request.query.from, request.query.to)
}

export function parseDateRangeValues(fromValue: unknown, toValue: unknown): DateRange {
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

export function encodeCursor(cursor: MessageCursor | null): string | null {
    return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null
}

export function decodeCursor(value: unknown): MessageCursor | undefined {
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

export function parseReportCursorId(value: unknown): number {
    // node-pg returns BIGSERIAL as string; accept both forms in encoded cursors.
    const id =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim()
              ? Number(value)
              : NaN
    if (!Number.isSafeInteger(id) || id < 1) {
        throw new Error('Invalid cursor')
    }
    return id
}

export function decodeReportCursor(value: unknown): DailySiteReportCursor | undefined {
    if (typeof value !== 'string' || !value) return undefined
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<DailySiteReportCursor>
        const id = parseReportCursorId(parsed.id)
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
            id,
        }
    } catch {
        throw new Error('Invalid cursor')
    }
}

export function parseReportDateField(value: unknown): DailySiteReportDateField {
    if (value === 'created' || value === 'message') return value
    return 'report'
}

export function parseReportSort(
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

export function encodeReportCursor(cursor: DailySiteReportCursor | null): string | null {
    return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null
}

export function parseLimit(value: unknown): number {
    if (typeof value !== 'string') return config.dashboardPageSize
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed) || parsed < 1) throw new Error('Invalid page size')
    return Math.min(parsed, config.dashboardMaxPageSize)
}

export function parseAlbumLimit(value: unknown): number {
    if (typeof value !== 'string') return config.albumPageSize
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed) || parsed < 1) throw new Error('Invalid album page size')
    return Math.min(parsed, config.albumMaxPageSize)
}

export function parseMediaCategories(value: unknown): MediaCategory[] {
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

export function parseFileNameQuery(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed || undefined
}

export function albumMessageTypes(categories: MediaCategory[], fileNameQuery?: string): string[] {
    if (fileNameQuery) return [...MEDIA_TYPES.document]
    return categories.flatMap((category) => MEDIA_TYPES[category])
}

export function parseOptionalGroups(query: Request['query']): string[] | undefined {
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

export function getRouteParam(value: string | string[] | undefined): string {
    if (typeof value !== 'string' || !value) throw new Error('Invalid route parameter')
    return value
}

export function isWithin(root: string, candidate: string): boolean {
    const pathFromRoot = relative(root, candidate)
    return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

export function resolveMediaPath(storedPath: string): string | undefined {
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

export function adminPasswordMatches(provided: string | undefined): boolean {
    const expected = Buffer.from(config.adminPassword)
    const actual = Buffer.from(provided ?? '')
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
}

export function requireAdmin(request: Request, response: Response, next: NextFunction): void {
    if (!adminPasswordMatches(request.get('x-admin-password'))) {
        response.status(401).json({ error: 'Invalid password' })
        return
    }
    next()
}
