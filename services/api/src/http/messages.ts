import type { Express } from 'express'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { config } from '../config.js'
import {
    getDashboardMedia,
    groupMatchesPattern,
    listDashboardGroups,
    listDashboardMessages,
} from '../../../../packages/shared/src/db/index.js'
import { contentDisposition } from '../../../../packages/shared/src/filenames.js'
import {
    decodeCursor,
    encodeCursor,
    getDateRange,
    getRouteParam,
    parseLimit,
    resolveMediaPath,
} from './helpers.js'


export function registerMessageRoutes(app: Express): void {
    app.get(
        '/api/groups',
        async (request, response) => {
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
        }
    )

    app.get(
        '/api/groups/:jid/messages',
        async (request, response) => {
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
        }
    )
    app.get(
        '/api/media/:messageId',
        async (request, response) => {
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
        }
    )
}
