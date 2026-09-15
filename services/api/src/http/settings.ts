import express, { type Express } from 'express'
import {
    getFilenameFormatSettings,
    parseFilenameFormatSettings,
    saveFilenameFormatSettings,
} from '../../../../packages/shared/src/filenameFormat.js'
import { requireAdmin } from './helpers.js'


export function registerSettingsRoutes(app: Express): void {
    app.get(
        '/api/settings/filename-format',
        requireAdmin,
        async (_request, response) => {
            response.json(await getFilenameFormatSettings())
        }
    )

    app.put(
        '/api/settings/filename-format',
        requireAdmin,
        express.json({ limit: '32kb' }),
        async (request, response) => {
            const parsed = parseFilenameFormatSettings(request.body)
            const saved = await saveFilenameFormatSettings(parsed)
            response.json(saved)
        }
    )
}
