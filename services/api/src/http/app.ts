import express, { type NextFunction, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getConnectionStatus } from '../../../../packages/shared/src/connectionStatus.js'
import { log } from '../../../../packages/shared/src/log.js'
import { handleReportProcessedSse, handleWorkflowStatusSse } from '../sse.js'
import { registerAlbumRoutes } from './album.js'
import { ROBOTS_TAG, ROBOTS_TXT, requireAdmin } from './helpers.js'
import { registerMessageRoutes } from './messages.js'
import { registerReportRoutes } from './reports.js'
import { registerSettingsRoutes } from './settings.js'
import { registerWorkflowRoutes } from './workflows.js'

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

    app.get('/api/status', async (_request, response) => {
        response.json(await getConnectionStatus())
    })

    app.post('/api/admin/verify', requireAdmin, (_request, response) => {
        response.json({ ok: true })
    })

    app.get('/api/events/report-processed', (request, response) => {
        handleReportProcessedSse(request, response)
    })

    app.get('/api/events/workflow-status', (request, response) => {
        handleWorkflowStatusSse(request, response)
    })

    registerMessageRoutes(app)
    registerAlbumRoutes(app)
    registerReportRoutes(app)
    registerWorkflowRoutes(app)
    registerSettingsRoutes(app)

    const webDist = fileURLToPath(new URL('../../../../apps/web/dist', import.meta.url))
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
            log.error({ err: error, method: request.method, path: request.path }, 'api.error')
        }
        response.status(status).json({ error: status === 500 ? 'Internal server error' : message })
    })

    return app
}
