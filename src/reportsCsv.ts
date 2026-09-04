import type { DailySiteReport } from './db.js'

export const DAILY_SITE_REPORT_CSV_HEADER = [
    '日期',
    'PO',
    'Ref',
    '承辦商',
    '項目名稱',
    'RSS',
    '工人',
    '開工人數',
    '工作內容',
    '累計開坑長度',
    '累計Coring長度',
    '累計拉線長度',
    '累計放筒長度',
    '累計探窿數量',
] as const

export function csvCell(value: string | number | null | undefined): string {
    const text = value == null ? '' : String(value)
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
    return text
}

export function dailySiteReportCsvRow(report: DailySiteReport): string {
    return [
        report.reportDate,
        report.poNumber,
        report.refNumbers.join(', '),
        report.contractor,
        report.projectName,
        report.rss,
        report.workers.join(', '),
        report.numWorkers,
        report.workScopes.join(', '),
        report.trenchLength,
        report.coringLength,
        report.cablePullingLength,
        report.conduitLayingLength,
        report.trialPitCount,
    ]
        .map(csvCell)
        .join(',')
}

export function buildDailySiteReportsCsv(reports: DailySiteReport[]): string {
    const lines = [DAILY_SITE_REPORT_CSV_HEADER.join(',')]
    for (const report of reports) {
        lines.push(dailySiteReportCsvRow(report))
    }
    return `\uFEFF${lines.join('\n')}`
}
