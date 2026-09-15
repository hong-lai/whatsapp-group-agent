import { ZipArchive } from 'archiver'
import express, { type Express } from 'express'
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { config } from '../config.js'
import {
    countAlbumMedia,
    getAlbumMediaForDownload,
    listAlbumMedia,
} from '../../../../packages/shared/src/db/index.js'
import { log } from '../../../../packages/shared/src/log.js'
import {
    sanitizeFilename,
    storedDownloadName,
    uniqueArchivePath,
} from '../../../../packages/shared/src/filenames.js'
import {
    albumMessageTypes,
    decodeCursor,
    encodeCursor,
    getDateRange,
    mediaCategoryForType,
    parseAlbumLimit,
    parseFileNameQuery,
    parseMediaCategories,
    parseOptionalGroups,
    resolveMediaPath,
} from './helpers.js'


export function registerAlbumRoutes(app: Express): void {
    app.get(
        '/api/album',
        async (request, response) => {
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
        }
    )
    app.post(
        '/api/album/download',
        express.json({ limit: '64kb' }),
        async (request, response) => {
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
                        : `${sanitizeFilename(item.groupName, item.groupJid)}/${filename}`,
                    usedPaths
                )
                archive.append(createReadStream(item.resolvedPath), { name: archivePath })
            }
            await archive.finalize()
        }
    )
}
