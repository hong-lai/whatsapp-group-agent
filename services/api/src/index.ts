import { initDb } from '../../../packages/shared/src/db/index.js'
import { loadFilenameFormatSettings } from '../../../packages/shared/src/filenameFormat.js'
import { log } from '../../../packages/shared/src/log.js'
import { config } from './config.js'
import { startDailySiteReportFileGenerator } from './dailySiteReportFile.js'
import { createApiApp } from './http/app.js'

export function startApi(): void {
    startDailySiteReportFileGenerator()
    createApiApp().listen(config.webPort, '0.0.0.0', () => {
        log.info({ port: config.webPort }, 'dashboard.listening')
    })
}

;(async () => {
    try {
        log.info({ port: config.webPort }, 'api.starting')
        await initDb()
        await loadFilenameFormatSettings()
        startApi()
    } catch (err) {
        log.error({ err }, 'api.start_failed')
        process.exit(1)
    }
})()
