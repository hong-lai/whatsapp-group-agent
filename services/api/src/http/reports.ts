import type { Express } from 'express'
import { publishReportChange } from '../../../../packages/shared/src/events/index.js'
import {
    deleteDailySiteReport,
    getDailySiteReportByMessageId,
    listDailySiteReportMetricsSeries,
    listDailySiteReports,
    listDailySiteReportsForExport,
} from '../../../../packages/shared/src/db/index.js'
import { buildDailySiteReportsCsv } from '../reportsCsv.js'
import {
    decodeReportCursor,
    encodeReportCursor,
    getDateRange,
    getRouteParam,
    parseFileNameQuery,
    parseLimit,
    parseReportDateField,
    parseReportSort,
    requireAdmin,
} from './helpers.js'


export function registerReportRoutes(app: Express): void {
    app.get(
        '/api/daily-site-reports',
        async (request, response) => {
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
        }
    )

    app.get(
        '/api/daily-site-reports/by-message/:messageId',
        async (request, response) => {
            const messageId = getRouteParam(request.params.messageId)
            const report = await getDailySiteReportByMessageId(messageId)
            if (!report) {
                response.status(404).json({ error: 'Report not found' })
                return
            }
            response.json({ report })
        }
    )

    app.get(
        '/api/daily-site-reports/export.csv',
        async (request, response) => {
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
        }
    )

    app.get(
        '/api/daily-site-reports/metrics-series',
        async (request, response) => {
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
        }
    )

    app.delete(
        '/api/daily-site-reports/:id',
        requireAdmin,
        async (request, response) => {
            const id = Number.parseInt(String(request.params.id), 10)
            if (!Number.isSafeInteger(id) || id < 1) {
                throw new Error('Invalid report id')
            }
            const deleted = await deleteDailySiteReport(id)
            if (!deleted) {
                response.status(404).json({ error: 'Report not found' })
                return
            }
            await publishReportChange({
                action: 'deleted',
                messageId: deleted.messageId,
                groupJid: deleted.groupJid,
                poNumber: deleted.poNumber,
                date: deleted.reportDate,
                contractor: deleted.contractor,
                reportId: deleted.id,
            })
            response.json({ ok: true })
        }
    )
}
