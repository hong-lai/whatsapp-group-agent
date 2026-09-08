import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { config } from './config.js'
import { getMessageHktDate, listDailySiteReportsForExport } from './db.js'
import { hktToday } from './hkt.js'
import { log } from './log.js'
import {
    onReportChange,
    type ReportChangePayload,
} from './reportProcessedEvents.js'
import { buildDailySiteReportsCsv } from './reportsCsv.js'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const FILE_NAME = 'daily_site_report.csv'

let pendingDate: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let started = false

export async function writeDailySiteReportCsvForMessageDate(
    messageDate: string
): Promise<string> {
    if (!DATE_PATTERN.test(messageDate)) {
        throw new Error(`Invalid message date: ${messageDate}`)
    }

    const reports = await listDailySiteReportsForExport({
        fromDate: messageDate,
        toDate: messageDate,
        dateField: 'message',
        sortBy: 'po',
        sortDir: 'asc',
        maxRows: 5000,
    })
    const csv = buildDailySiteReportsCsv(reports)
    const dir = join(resolve(config.reportsDir), messageDate)
    const filePath = join(dir, FILE_NAME)
    await mkdir(dir, { recursive: true })
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmpPath, csv, 'utf8')
    await rename(tmpPath, filePath)
    log.info(
        { messageDate, path: filePath, rows: reports.length },
        'daily_site_report_file.written'
    )
    return filePath
}

function scheduleWrite(messageDate: string): void {
    pendingDate = messageDate
    if (timer) clearTimeout(timer)
    const delayMs = Math.max(0, config.dailySiteReportFileDebounceMs)
    timer = setTimeout(() => {
        timer = null
        const date = pendingDate
        pendingDate = null
        if (!date) return
        void writeDailySiteReportCsvForMessageDate(date).catch((error: unknown) => {
            log.warn({ err: String(error), messageDate: date }, 'daily_site_report_file.write_failed')
        })
    }, delayMs)
}

export function scheduleDailySiteReportFileForMessageDate(messageDate: string): void {
    if (!DATE_PATTERN.test(messageDate)) return
    if (messageDate !== hktToday()) return
    scheduleWrite(messageDate)
}

async function handleReportChange(payload: ReportChangePayload): Promise<void> {
    try {
        const messageDate = await getMessageHktDate(payload.messageId)
        if (!messageDate) return
        scheduleDailySiteReportFileForMessageDate(messageDate)
    } catch (error) {
        log.warn(
            { err: String(error), messageId: payload.messageId },
            'daily_site_report_file.schedule_failed'
        )
    }
}

/** Subscribe to report.processed and write `{reportsDir}/{messageDate}/daily_site_report.csv`. */
export function startDailySiteReportFileGenerator(): void {
    if (started) return
    started = true
    onReportChange((payload) => {
        void handleReportChange(payload)
    })
    log.info(
        {
            reportsDir: resolve(config.reportsDir),
            debounceMs: config.dailySiteReportFileDebounceMs,
        },
        'daily_site_report_file.started'
    )
}
