import { getAppSetting, setAppSetting } from './db.js'
import {
    fileStem,
    firstAvailableName,
    hktStamp,
    mediaExtension,
    safePathSegment,
} from './hkt.js'
import { log } from './log.js'

export const FILENAME_FORMAT_KEY = 'filename-format'
export const GROUP_NAME_REGEX_MAX = 200
const STEM_MAX = 200

export const FILENAME_MEDIA_TYPES = [
    'images',
    'videos',
    'documents',
    'stickers',
    'audios',
] as const

export type FilenameMediaType = (typeof FILENAME_MEDIA_TYPES)[number]

export const FILENAME_TOKENS = [
    'datetime',
    'filename',
    'groupName',
    'messageId',
    'mediaIndex',
    'senderName',
] as const

export type FilenameToken = (typeof FILENAME_TOKENS)[number]

export type FilenameTypePattern = {
    tokens: FilenameToken[]
    groupNameRegex: string
}

export type FilenameFormatSettings = Record<FilenameMediaType, FilenameTypePattern>

export type FilenameContext = {
    timestamp: number
    messageId: string
    originalName: string | null
    groupName: string
    mediaIndex: number | null
    senderName: string | null
    mediaPath: string
}

const MESSAGE_TYPE_TO_FILENAME_TYPE: Record<string, FilenameMediaType> = {
    imageMessage: 'images',
    videoMessage: 'videos',
    documentMessage: 'documents',
    stickerMessage: 'stickers',
    audioMessage: 'audios',
}

function pattern(tokens: FilenameToken[]): FilenameTypePattern {
    return { tokens: [...tokens], groupNameRegex: '' }
}

export function defaultFilenameFormatSettings(): FilenameFormatSettings {
    return {
        images: pattern(['datetime', 'messageId']),
        videos: pattern(['datetime', 'messageId']),
        documents: pattern(['datetime', 'filename']),
        stickers: pattern(['datetime', 'messageId']),
        audios: pattern(['datetime', 'messageId']),
    }
}

let cached = defaultFilenameFormatSettings()

export function getFilenameFormatSettings(): FilenameFormatSettings {
    return cached
}

export function filenameTypeForMessage(messageType: string): FilenameMediaType | undefined {
    return MESSAGE_TYPE_TO_FILENAME_TYPE[messageType]
}

export function extractGroupNameToken(groupName: string, regexSource: string): string | null {
    const trimmed = regexSource.trim()
    if (!trimmed) {
        const sanitized = safePathSegment(groupName, '')
        return sanitized || null
    }

    let regex: RegExp
    try {
        regex = new RegExp(trimmed, 'g')
    } catch {
        return null
    }

    const captures: string[] = []
    for (const match of groupName.matchAll(regex)) {
        if (match.length > 1) {
            for (let i = 1; i < match.length; i++) {
                const group = match[i]
                if (group) captures.push(group)
            }
        } else if (match[0]) {
            captures.push(match[0])
        }
    }
    if (captures.length === 0) return null
    const sanitized = safePathSegment(captures.join('_'), '')
    return sanitized || null
}

function resolveToken(
    token: FilenameToken,
    typePattern: FilenameTypePattern,
    ctx: FilenameContext
): string | null {
    switch (token) {
        case 'datetime': {
            const stamp = hktStamp(ctx.timestamp)
            return `${stamp.date}_${stamp.time}`
        }
        case 'messageId':
            return safePathSegment(ctx.messageId, '') || null
        case 'filename': {
            const source = ctx.originalName?.trim() || ''
            if (!source) return null
            const stem = fileStem(source, '')
            return stem || null
        }
        case 'groupName':
            return extractGroupNameToken(ctx.groupName, typePattern.groupNameRegex)
        case 'mediaIndex':
            return ctx.mediaIndex == null ? null : String(ctx.mediaIndex + 1)
        case 'senderName': {
            const name = ctx.senderName?.trim() || ''
            if (!name) return null
            return safePathSegment(name, '') || null
        }
    }
}

export function buildMediaFilename(typePattern: FilenameTypePattern, ctx: FilenameContext): string {
    const extension = mediaExtension(ctx.originalName?.trim() || ctx.mediaPath)
    const selected = new Set(typePattern.tokens)
    const parts: string[] = []
    for (const token of FILENAME_TOKENS) {
        if (!selected.has(token)) continue
        const value = resolveToken(token, typePattern, ctx)
        if (value) parts.push(value)
    }
    if (parts.length === 0) {
        parts.push(safePathSegment(ctx.messageId, 'media'))
    }

    let stem = parts.join('_')
    if (stem.length > STEM_MAX) stem = stem.slice(0, STEM_MAX)
    return `${stem}${extension}`
}

export function uniqueMediaPath(
    folderPath: string,
    filename: string,
    exists: (path: string) => boolean
): string {
    return firstAvailableName(`${folderPath}/${filename}`, exists)
}

function isFilenameToken(value: unknown): value is FilenameToken {
    return typeof value === 'string' && (FILENAME_TOKENS as readonly string[]).includes(value)
}

function parseTypePattern(raw: unknown, type: FilenameMediaType): FilenameTypePattern {
    if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) {
        throw new Error(`Invalid filename format for ${type}`)
    }
    const input = raw as Record<string, unknown>
    if (!Array.isArray(input.tokens)) {
        throw new Error(`Invalid filename tokens for ${type}`)
    }

    const selected = new Set<FilenameToken>()
    for (const item of input.tokens) {
        if (item === 'deleted') continue
        if (!isFilenameToken(item)) {
            throw new Error(`Invalid filename token for ${type}`)
        }
        selected.add(item)
    }
    const tokens = FILENAME_TOKENS.filter((token) => selected.has(token))

    if (input.groupNameRegex !== undefined && typeof input.groupNameRegex !== 'string') {
        throw new Error(`Invalid group name regex for ${type}`)
    }
    const groupNameRegex = typeof input.groupNameRegex === 'string' ? input.groupNameRegex : ''
    if (groupNameRegex.length > GROUP_NAME_REGEX_MAX) {
        throw new Error(`Invalid group name regex for ${type}`)
    }

    return { tokens, groupNameRegex }
}

export function parseFilenameFormatSettings(raw: unknown): FilenameFormatSettings {
    const defaults = defaultFilenameFormatSettings()
    if (raw == null) return defaults
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid filename format settings')
    }

    const input = raw as Record<string, unknown>
    const extra = Object.keys(input).filter(
        (key) => !(FILENAME_MEDIA_TYPES as readonly string[]).includes(key)
    )
    if (extra.length > 0) {
        throw new Error('Invalid filename format settings')
    }

    const result = { ...defaults }
    for (const type of FILENAME_MEDIA_TYPES) {
        if (!(type in input)) continue
        result[type] = parseTypePattern(input[type], type)
    }
    return result
}

export async function loadFilenameFormatSettings(): Promise<FilenameFormatSettings> {
    try {
        cached = parseFilenameFormatSettings(await getAppSetting(FILENAME_FORMAT_KEY))
    } catch (err) {
        cached = defaultFilenameFormatSettings()
        log.warn({ err }, 'settings.filename_format_invalid')
    }
    return cached
}

export async function saveFilenameFormatSettings(
    settings: FilenameFormatSettings
): Promise<FilenameFormatSettings> {
    const parsed = parseFilenameFormatSettings(settings)
    await setAppSetting(FILENAME_FORMAT_KEY, parsed)
    cached = parsed
    return cached
}
