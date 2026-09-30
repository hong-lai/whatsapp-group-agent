import express, { type Express } from 'express'
import {
    getGroupOverview,
    getReportSectionJids,
    setReportSectionJids,
} from '../../../../packages/shared/src/db/index.js'
import { getDateRange, requireAdmin } from './helpers.js'

export function registerOverviewRoutes(app: Express): void {
    app.get('/api/overview', async (request, response) => {
        const range = getDateRange(request)
        const [overview, sectionJids] = await Promise.all([
            getGroupOverview(range.from, range.to, range.fromTimestamp, range.toTimestamp),
            getReportSectionJids(),
        ])
        const section = new Set(sectionJids)
        response.json({
            range: { from: range.from, to: range.to },
            totals: overview.totals,
            groups: overview.groups.map((group) => ({
                ...group,
                inReportSection: section.has(group.jid),
            })),
        })
    })

    app.put(
        '/api/overview/report-section',
        requireAdmin,
        express.json({ limit: '64kb' }),
        async (request, response) => {
            const jids = (request.body as { jids?: unknown } | undefined)?.jids
            if (!Array.isArray(jids) || jids.some((jid) => typeof jid !== 'string')) {
                response.status(400).json({ error: 'Expected a list of group ids.' })
                return
            }
            response.json({ jids: await setReportSectionJids(jids) })
        }
    )
}
