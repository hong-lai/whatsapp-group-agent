import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Drawer from './Drawer'
import { useInfiniteScroll, useVisibleInterval } from './useVisibleInterval'

export type DailySiteReportIssue = {
    code: 'missing_fields' | 'date_mismatch' | 'workers_over'
    label: string
}

export type DailySiteReportDateField = 'report' | 'created'

export type DailySiteReport = {
    id: number
    messageId: string
    groupJid: string
    groupName: string
    reportDate: string | null
    createdDate: string
    poNumber: string | null
    refNumbers: string[]
    contractor: string | null
    projectName: string | null
    rss: string | null
    workers: string[]
    numWorkers: number | null
    workScopes: string[]
    trenchLength: number
    coringLength: number
    cablePullingLength: number
    conduitLayingLength: number
    trialPitCount: number
    remarks: string | null
    sourceText: string | null
    messageTimestamp: number | null
    messageDate: string | null
    messageIsEdited: boolean
    messageIsDeleted: boolean
    createdAt: string
    updatedAt: string
    issues: DailySiteReportIssue[]
    isValid: boolean
}

type ReportsResponse = {
    reports: DailySiteReport[]
    nextCursor: string | null
    total: number
    dateField: DailySiteReportDateField
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, { signal })
    const body = (await response.json()) as T & { error?: string }
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
    return body
}

function joinList(items: string[]): string {
    return items.length ? items.join('、') : '—'
}

function TruncatedText({
    text,
    className,
    empty = '—',
}: {
    text: string | null | undefined
    className?: string
    empty?: string
}) {
    const ref = useRef<HTMLSpanElement>(null)
    const display = text?.trim() || empty
    const full = text?.trim() || ''

    function syncTitle() {
        const el = ref.current
        if (!el || !full || display === empty) {
            el?.removeAttribute('title')
            return
        }
        const truncated =
            el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
        if (truncated) el.setAttribute('title', full)
        else el.removeAttribute('title')
    }

    return (
        <span ref={ref} className={className} onMouseEnter={syncTitle}>
            {display}
        </span>
    )
}

const REPORT_TABLE_COLUMNS_STORAGE_KEY = 'reportsTableColumns'
const REPORT_TABLE_SORT_STORAGE_KEY = 'reportsTableSort'

type ReportTableColumnId =
    | 'reportDate'
    | 'createdDate'
    | 'messageDate'
    | 'po'
    | 'ref'
    | 'contractor'
    | 'project'
    | 'groupName'
    | 'rss'
    | 'workers'
    | 'numWorkers'
    | 'workScopes'
    | 'trench'
    | 'coring'
    | 'cable'
    | 'conduit'
    | 'trialPit'
    | 'remarks'
    | 'status'
    | 'flags'
    | 'updatedAt'

type ReportSortBy = ReportTableColumnId | 'createdAt'
type ReportSortDir = 'asc' | 'desc'
type ReportSortState = { sortBy: ReportSortBy; sortDir: ReportSortDir }

type ReportTableColumn = {
    id: ReportTableColumnId
    className?: string
    label: string
    title?: string
    sortable?: boolean
    defaultVisible?: boolean
}

const REPORT_TABLE_COLUMNS: ReportTableColumn[] = [
    { id: 'reportDate', className: 'col-date', label: '報告日期' },
    { id: 'createdDate', className: 'col-date', label: '建立日期', defaultVisible: false },
    { id: 'messageDate', className: 'col-date', label: '訊息日期', defaultVisible: false },
    { id: 'po', className: 'col-po', label: 'PO' },
    { id: 'ref', label: 'Ref' },
    { id: 'contractor', label: '承辦商' },
    { id: 'project', className: 'col-project', label: '項目名稱' },
    { id: 'groupName', className: 'col-group', label: '群組', defaultVisible: false },
    { id: 'rss', className: 'col-rss', label: 'RSS' },
    { id: 'workers', className: 'col-workers', label: '工人' },
    { id: 'numWorkers', className: 'col-num', label: '開工', title: '開工人數' },
    { id: 'workScopes', className: 'col-scope', label: '工作內容' },
    { id: 'trench', className: 'col-metric', label: '開坑', title: '累計開坑長度' },
    { id: 'coring', className: 'col-metric', label: 'Coring', title: '累計Coring長度' },
    { id: 'cable', className: 'col-metric', label: '拉線', title: '累計拉線長度' },
    { id: 'conduit', className: 'col-metric', label: '放筒', title: '累計放筒長度' },
    { id: 'trialPit', className: 'col-metric', label: '探窿', title: '累計探窿數量' },
    { id: 'remarks', className: 'col-remarks', label: '備註' },
    { id: 'status', className: 'col-status', label: '狀態', defaultVisible: false },
    { id: 'flags', className: 'col-flags', label: '訊息' },
    {
        id: 'updatedAt',
        className: 'col-updated',
        label: '更新',
        title: '最後更新',
        defaultVisible: false,
    },
]

const REPORT_TABLE_COLUMN_IDS = REPORT_TABLE_COLUMNS.map((column) => column.id)
const REPORT_TABLE_DEFAULT_VISIBLE_IDS = REPORT_TABLE_COLUMNS.filter(
    (column) => column.defaultVisible !== false
).map((column) => column.id)
const REPORT_SORT_BY_IDS: ReportSortBy[] = [...REPORT_TABLE_COLUMN_IDS, 'createdAt']

function defaultReportSort(dateField: DailySiteReportDateField): ReportSortState {
    return dateField === 'created'
        ? { sortBy: 'createdAt', sortDir: 'desc' }
        : { sortBy: 'reportDate', sortDir: 'desc' }
}

function readReportSort(dateField: DailySiteReportDateField): ReportSortState {
    const defaults = defaultReportSort(dateField)
    if (typeof localStorage === 'undefined') return defaults
    try {
        const raw = localStorage.getItem(REPORT_TABLE_SORT_STORAGE_KEY)
        if (!raw) return defaults
        const parsed = JSON.parse(raw) as Partial<ReportSortState>
        if (!REPORT_SORT_BY_IDS.includes(parsed.sortBy as ReportSortBy)) return defaults
        if (parsed.sortDir !== 'asc' && parsed.sortDir !== 'desc') return defaults
        return { sortBy: parsed.sortBy as ReportSortBy, sortDir: parsed.sortDir }
    } catch {
        return defaults
    }
}

function readVisibleReportColumns(): Set<ReportTableColumnId> {
    const defaults = new Set(REPORT_TABLE_DEFAULT_VISIBLE_IDS)
    if (typeof localStorage === 'undefined') return defaults
    try {
        const raw = localStorage.getItem(REPORT_TABLE_COLUMNS_STORAGE_KEY)
        if (!raw) return defaults
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) return defaults
        const valid = parsed.filter((id): id is ReportTableColumnId =>
            REPORT_TABLE_COLUMN_IDS.includes(id as ReportTableColumnId)
        )
        return valid.length ? new Set(valid) : defaults
    } catch {
        return defaults
    }
}

function renderReportTableCell(report: DailySiteReport, columnId: ReportTableColumnId) {
    switch (columnId) {
        case 'reportDate':
            return (
                <td
                    key={columnId}
                    className={`col-date${hasIssue(report, 'date_mismatch') ? ' cell-warn' : ''}`}
                >
                    <span className="reports-date-pill">{report.reportDate || '—'}</span>
                </td>
            )
        case 'createdDate':
            return (
                <td key={columnId} className="col-date">
                    <span className="reports-date-pill">{report.createdDate}</span>
                </td>
            )
        case 'messageDate':
            return (
                <td
                    key={columnId}
                    className={`col-date${hasIssue(report, 'date_mismatch') ? ' cell-warn' : ''}`}
                >
                    <span className="reports-date-pill">{report.messageDate || '—'}</span>
                </td>
            )
        case 'po':
            return (
                <td key={columnId} className="col-po">
                    <TruncatedText
                        text={report.poNumber}
                        className="cell-ellipsis cell-ellipsis--strong"
                    />
                </td>
            )
        case 'ref':
            return (
                <td key={columnId} className="cell-wrap">
                    <TruncatedText
                        text={
                            report.refNumbers.length ? report.refNumbers.join('、') : null
                        }
                        className="cell-ellipsis"
                    />
                </td>
            )
        case 'contractor':
            return (
                <td key={columnId} className="cell-contractor">
                    <TruncatedText text={report.contractor} className="cell-ellipsis" />
                </td>
            )
        case 'project':
            return (
                <td key={columnId} className="cell-wrap col-project">
                    <TruncatedText text={report.projectName} className="cell-ellipsis" />
                </td>
            )
        case 'groupName':
            return (
                <td key={columnId} className="cell-wrap col-group">
                    <TruncatedText text={report.groupName} className="cell-ellipsis" />
                </td>
            )
        case 'rss':
            return (
                <td key={columnId} className="col-rss">
                    <TruncatedText
                        text={report.rss}
                        className={`cell-ellipsis${report.rss ? ' rss-name' : ' reports-cell-empty'}`}
                    />
                </td>
            )
        case 'workers':
            return (
                <td key={columnId} className="col-workers">
                    <WorkersDropdown workers={report.workers} />
                </td>
            )
        case 'numWorkers':
            return (
                <td key={columnId} className="col-num">
                    <ReportNumber
                        value={report.numWorkers}
                        variant="workers"
                        warn={hasIssue(report, 'workers_over')}
                    />
                </td>
            )
        case 'workScopes':
            return (
                <td key={columnId} className="cell-wrap col-scope">
                    <TruncatedText
                        text={
                            report.workScopes.length ? report.workScopes.join('、') : null
                        }
                        className="cell-ellipsis"
                    />
                </td>
            )
        case 'trench':
            return (
                <td key={columnId} className="col-metric">
                    <ReportNumber value={report.trenchLength} />
                </td>
            )
        case 'coring':
            return (
                <td key={columnId} className="col-metric">
                    <ReportNumber value={report.coringLength} />
                </td>
            )
        case 'cable':
            return (
                <td key={columnId} className="col-metric">
                    <ReportNumber value={report.cablePullingLength} />
                </td>
            )
        case 'conduit':
            return (
                <td key={columnId} className="col-metric">
                    <ReportNumber value={report.conduitLayingLength} />
                </td>
            )
        case 'trialPit':
            return (
                <td key={columnId} className="col-metric">
                    <ReportNumber value={report.trialPitCount} />
                </td>
            )
        case 'remarks':
            return (
                <td key={columnId} className="cell-wrap col-remarks">
                    <TruncatedText text={report.remarks} className="cell-ellipsis" />
                </td>
            )
        case 'status':
            return (
                <td key={columnId} className="col-status">
                    <ReportStatus report={report} />
                </td>
            )
        case 'flags':
            return (
                <td key={columnId} className="col-flags">
                    <MessageFlags report={report} compact />
                </td>
            )
        case 'updatedAt':
            return (
                <td key={columnId} className="col-updated">
                    <TruncatedText
                        text={formatHktDateTime(report.updatedAt)}
                        className="cell-ellipsis"
                    />
                </td>
            )
    }
}

function ReportColumnPicker({
    visibleColumns,
    onChange,
}: {
    visibleColumns: Set<ReportTableColumnId>
    onChange: (next: Set<ReportTableColumnId>) => void
}) {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const hiddenCount = REPORT_TABLE_COLUMN_IDS.length - visibleColumns.size

    useEffect(() => {
        if (!open) return undefined
        function onPointerDown(event: PointerEvent) {
            if (rootRef.current?.contains(event.target as Node)) return
            setOpen(false)
        }
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open])

    function toggleColumn(columnId: ReportTableColumnId) {
        const next = new Set(visibleColumns)
        if (next.has(columnId)) {
            if (next.size <= 1) return
            next.delete(columnId)
        } else {
            next.add(columnId)
        }
        onChange(next)
    }

    return (
        <div
            className={`reports-column-picker desktop-only${open ? ' is-open' : ''}`}
            ref={rootRef}
        >
            <button
                type="button"
                className="reports-column-picker-trigger"
                aria-expanded={open}
                aria-haspopup="true"
                onClick={() => setOpen((current) => !current)}
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 6h16" />
                    <path d="M4 12h10" />
                    <path d="M4 18h14" />
                </svg>
                欄位
                {hiddenCount > 0 && (
                    <span className="reports-column-picker-badge">{hiddenCount}</span>
                )}
            </button>
            {open && (
                <div className="reports-column-picker-panel" role="group" aria-label="Table columns">
                    <div className="reports-column-picker-head">
                        <span>顯示欄位</span>
                        <button
                            type="button"
                            onClick={() => onChange(new Set(REPORT_TABLE_COLUMN_IDS))}
                        >
                            全部
                        </button>
                    </div>
                    <ul className="reports-column-picker-list">
                        {REPORT_TABLE_COLUMNS.map((column) => (
                            <li key={column.id}>
                                <label className="reports-column-picker-option">
                                    <input
                                        type="checkbox"
                                        checked={visibleColumns.has(column.id)}
                                        onChange={() => toggleColumn(column.id)}
                                    />
                                    <span>{column.title ?? column.label}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}

function ReportTableHeader({
    label,
    title,
    className,
    sortable = true,
    sortDir,
    onSort,
}: {
    label: string
    title?: string
    className?: string
    sortable?: boolean
    sortDir?: ReportSortDir | null
    onSort?: () => void
}) {
    const ref = useRef<HTMLTableCellElement>(null)
    const full = title ?? label

    function syncTitle() {
        const el = ref.current
        if (!el) return
        const truncated = el.scrollWidth > el.clientWidth + 1
        if (truncated || full !== label) el.setAttribute('title', full)
        else el.removeAttribute('title')
    }

    if (!sortable || !onSort) {
        return (
            <th ref={ref} className={className} onMouseEnter={syncTitle}>
                {label}
            </th>
        )
    }

    return (
        <th
            ref={ref}
            className={`${className ?? ''} is-sortable${sortDir ? ` is-sorted is-sorted--${sortDir}` : ''}`.trim()}
            aria-sort={sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : 'none'}
            onMouseEnter={syncTitle}
        >
            <button type="button" className="reports-sort-btn" onClick={onSort}>
                <span>{label}</span>
                <span className="reports-sort-icon" aria-hidden="true">
                    {sortDir === 'asc' ? '↑' : sortDir === 'desc' ? '↓' : '↕'}
                </span>
            </button>
        </th>
    )
}

function formatHktDateTime(iso: string): string {
    return new Date(iso).toLocaleString('zh-HK', {
        timeZone: 'Asia/Hong_Kong',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    })
}

function exportUrl(
    from: string,
    to: string,
    groupJid: string | null,
    query: string,
    dateField: DailySiteReportDateField,
    sort: ReportSortState
): string {
    const params = new URLSearchParams({
        from,
        to,
        dateField,
        sortBy: sort.sortBy,
        sortDir: sort.sortDir,
    })
    if (groupJid) params.set('group', groupJid)
    if (query.trim()) params.set('q', query.trim())
    return `/api/daily-site-reports/export.csv?${params}`
}

function hasIssue(report: DailySiteReport, code: DailySiteReportIssue['code']): boolean {
    return report.issues.some((issue) => issue.code === code)
}

function ReportStatus({ report }: { report: DailySiteReport }) {
    if (report.isValid) {
        return <span className="report-status report-status--ok">正常</span>
    }
    return (
        <div className="report-status-list">
            {report.issues.map((issue) => (
                <span key={issue.code} className={`report-status report-status--${issue.code}`}>
                    {issue.label}
                </span>
            ))}
        </div>
    )
}

function WorkersDropdown({ workers }: { workers: string[] }) {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return undefined
        function onPointerDown(event: PointerEvent) {
            if (rootRef.current?.contains(event.target as Node)) return
            setOpen(false)
        }
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open])

    if (!workers.length) {
        return <span className="reports-cell-empty">—</span>
    }

    const label = workers.length === 1 ? '1 人' : `${workers.length} 人`

    return (
        <div
            className={`workers-dropdown${open ? ' is-open' : ''}`}
            ref={rootRef}
            onClick={(event) => event.stopPropagation()}
        >
            <button
                type="button"
                className="workers-dropdown-trigger"
                aria-expanded={open}
                aria-haspopup="listbox"
                onClick={() => setOpen((current) => !current)}
            >
                <span className="workers-dropdown-count">{label}</span>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m6 9 6 6 6-6" />
                </svg>
            </button>
            {open && (
                <ul className="workers-dropdown-menu" role="listbox">
                    {workers.map((name) => (
                        <li key={name} className="workers-dropdown-item workers-dropdown-item--worker" role="option">
                            <span>{name}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

function ReportNumber({
    value,
    variant = 'metric',
    warn = false,
}: {
    value: number | null
    variant?: 'workers' | 'metric'
    warn?: boolean
}) {
    if (value == null) {
        return <span className="report-num report-num--empty">—</span>
    }

    const state = value === 0 ? 'zero' : 'active'
    return (
        <span
            className={`report-num report-num--${variant} report-num--${state}${warn ? ' report-num--warn' : ''}`}
        >
            {value}
        </span>
    )
}

function MessageFlags({ report, compact = false }: { report: DailySiteReport; compact?: boolean }) {
    if (!report.messageIsEdited && !report.messageIsDeleted) {
        return compact ? null : <span className="message-flag message-flag--none">—</span>
    }
    return (
        <div className={`message-flags${compact ? ' message-flags--compact' : ''}`}>
            {report.messageIsDeleted && (
                <span className="message-flag message-flag--deleted" title="訊息已刪除">
                    已刪除
                </span>
            )}
            {report.messageIsEdited && (
                <span
                    className="message-flag message-flag--edited"
                    title={`最後更新 ${formatHktDateTime(report.updatedAt)}`}
                >
                    已編輯
                </span>
            )}
        </div>
    )
}

const REPORT_MOBILE_METRICS: { label: string; title: string; key: keyof DailySiteReport }[] = [
    { label: '開工', title: '開工人數', key: 'numWorkers' },
    { label: '開坑', title: '累計開坑長度', key: 'trenchLength' },
    { label: 'Coring', title: '累計Coring長度', key: 'coringLength' },
    { label: '拉線', title: '累計拉線長度', key: 'cablePullingLength' },
    { label: '放筒', title: '累計放筒長度', key: 'conduitLayingLength' },
    { label: '探窿', title: '累計探窿數量', key: 'trialPitCount' },
]

function ReportMobileCard({
    report,
    onSelect,
}: {
    report: DailySiteReport
    onSelect: () => void
}) {
    const meta = [report.contractor, report.rss].filter(Boolean).join(' · ')
    const scope =
        report.workScopes.length > 0 ? report.workScopes.join('、') : null

    return (
        <article
            className={`report-mobile-card${report.isValid ? '' : ' report-mobile-card--invalid'}`}
            onClick={onSelect}
        >
            <div className="report-mobile-card-head">
                <span
                    className={`reports-date-pill${
                        hasIssue(report, 'date_mismatch') ? ' report-mobile-card-date--warn' : ''
                    }`}
                >
                    {report.reportDate || '—'}
                </span>
                <strong className="report-mobile-card-po">{report.poNumber?.trim() || '—'}</strong>
                <MessageFlags report={report} compact />
            </div>

            <h3 className="report-mobile-card-title">
                {report.projectName?.trim() || '—'}
            </h3>

            {(meta || report.refNumbers.length > 0) && (
                <p className="report-mobile-card-meta">
                    {meta}
                    {meta && report.refNumbers.length > 0 ? ' · ' : ''}
                    {report.refNumbers.length > 0 ? report.refNumbers.join('、') : ''}
                </p>
            )}

            {scope && <p className="report-mobile-card-scope">{scope}</p>}

            <div className="report-mobile-card-metrics" aria-label="Report metrics">
                {REPORT_MOBILE_METRICS.map((metric) => {
                    const raw = report[metric.key]
                    const value = typeof raw === 'number' ? raw : null
                    const isWorkers = metric.key === 'numWorkers'
                    return (
                        <div key={metric.key} className="report-mobile-metric" title={metric.title}>
                            <span className="report-mobile-metric-label">{metric.label}</span>
                            <ReportNumber
                                value={value}
                                variant={isWorkers ? 'workers' : 'metric'}
                                warn={isWorkers && hasIssue(report, 'workers_over')}
                            />
                        </div>
                    )
                })}
            </div>

            <div className="report-mobile-card-foot">
                <WorkersDropdown workers={report.workers} />
                {report.remarks?.trim() && (
                    <p className="report-mobile-card-remarks">{report.remarks.trim()}</p>
                )}
            </div>
        </article>
    )
}

function drawerSubtitle(report: DailySiteReport): string | undefined {
    const parts: string[] = []
    if (report.messageIsDeleted) parts.push('訊息已刪除')
    if (report.messageIsEdited) parts.push(`已編輯 · ${formatHktDateTime(report.updatedAt)}`)
    if (!report.isValid) {
        parts.push(report.issues.map((issue) => issue.label).join(' · '))
    }
    return parts.length ? parts.join(' · ') : undefined
}

function ReportDeleteDialog({
    open,
    report,
    onClose,
    onDeleted,
}: {
    open: boolean
    report: DailySiteReport
    onClose: () => void
    onDeleted: (id: number) => void
}) {
    const [adminPassword, setAdminPassword] = useState('')
    const [deleting, setDeleting] = useState(false)
    const [deleteError, setDeleteError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const deletingRef = useRef(false)
    const onCloseRef = useRef(onClose)
    deletingRef.current = deleting
    onCloseRef.current = onClose

    useEffect(() => {
        if (!open) return undefined
        setAdminPassword('')
        setDeleteError(null)
        setDeleting(false)
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 40)

        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape' && !deletingRef.current) onCloseRef.current()
        }
        window.addEventListener('keydown', onKey)
        return () => {
            document.body.style.overflow = previous
            window.removeEventListener('keydown', onKey)
            window.clearTimeout(focusTimer)
        }
    }, [open])

    async function handleDelete() {
        if (!adminPassword.trim()) {
            setDeleteError('請輸入管理員密碼')
            return
        }
        setDeleting(true)
        setDeleteError(null)
        try {
            const response = await fetch(`/api/daily-site-reports/${report.id}`, {
                method: 'DELETE',
                headers: { 'x-admin-password': adminPassword.trim() },
            })
            const body = (await response.json()) as { error?: string }
            if (!response.ok) {
                throw new Error(body.error || `Delete failed (${response.status})`)
            }
            onDeleted(report.id)
        } catch (reason) {
            setDeleteError(reason instanceof Error ? reason.message : 'Could not delete report')
        } finally {
            setDeleting(false)
        }
    }

    if (!open) return null

    const summary = [report.poNumber?.trim(), report.projectName?.trim()].filter(Boolean).join(' · ')

    return createPortal(
        <div
            className="report-delete-overlay"
            role="presentation"
            onClick={() => {
                if (!deleting) onClose()
            }}
        >
            <div
                className="report-delete-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="report-delete-title"
                aria-describedby="report-delete-desc"
                onClick={(event) => event.stopPropagation()}
            >
                <header className="report-delete-dialog-header">
                    <div>
                        <h3 id="report-delete-title">永久刪除報告？</h3>
                        {summary && <p className="report-delete-dialog-summary">{summary}</p>}
                    </div>
                    <button
                        type="button"
                        className="report-delete-dialog-close"
                        aria-label="Close"
                        disabled={deleting}
                        onClick={onClose}
                    >
                        ×
                    </button>
                </header>

                <p id="report-delete-desc" className="report-delete-warning">
                    此操作<strong>無法復原</strong>。報告將從資料庫永久刪除。
                </p>

                <label className="report-delete-password">
                    <span>管理員密碼</span>
                    <input
                        ref={inputRef}
                        type="password"
                        value={adminPassword}
                        autoComplete="current-password"
                        disabled={deleting}
                        onChange={(event) => setAdminPassword(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') void handleDelete()
                        }}
                    />
                </label>

                {deleteError && <p className="report-delete-error">{deleteError}</p>}

                <div className="report-delete-actions">
                    <button
                        type="button"
                        className="report-delete-cancel"
                        disabled={deleting}
                        onClick={onClose}
                    >
                        取消
                    </button>
                    <button
                        type="button"
                        className="report-delete-submit"
                        disabled={deleting}
                        onClick={() => void handleDelete()}
                    >
                        {deleting ? '刪除中…' : '永久刪除'}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    )
}

function ReportDetail({
    report,
    onDeleted,
    onReran,
    onModalOpenChange,
}: {
    report: DailySiteReport
    onDeleted: (id: number) => void
    onReran?: () => void
    onModalOpenChange?: (open: boolean) => void
}) {
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [debugOpen, setDebugOpen] = useState(false)

    useEffect(() => {
        onModalOpenChange?.(deleteOpen || debugOpen)
        return () => onModalOpenChange?.(false)
    }, [deleteOpen, debugOpen, onModalOpenChange])

    const rows: Array<{ label: string; value: string; warn?: boolean }> = [
        { label: '報告日期', value: report.reportDate || '—', warn: hasIssue(report, 'date_mismatch') },
        { label: '建立日期', value: report.createdDate },
        { label: '訊息日期', value: report.messageDate || '—', warn: hasIssue(report, 'date_mismatch') },
        { label: 'PO', value: report.poNumber || '—', warn: !report.poNumber?.trim() },
        { label: 'Ref', value: joinList(report.refNumbers), warn: report.refNumbers.length === 0 },
        { label: '承辦商', value: report.contractor || '—', warn: !report.contractor?.trim() },
        { label: '項目名稱', value: report.projectName || '—', warn: !report.projectName?.trim() },
        { label: '群組', value: report.groupName },
        { label: 'RSS', value: report.rss || '—', warn: !report.rss?.trim() },
        { label: '工人', value: joinList(report.workers), warn: report.workers.length === 0 },
        {
            label: '開工人數',
            value: report.numWorkers?.toString() ?? '—',
            warn: report.numWorkers == null || hasIssue(report, 'workers_over'),
        },
        { label: '工作內容', value: joinList(report.workScopes), warn: report.workScopes.length === 0 },
        { label: '累計開坑長度', value: `${report.trenchLength} 米` },
        { label: '累計Coring長度', value: `${report.coringLength} 米` },
        { label: '累計拉線長度', value: `${report.cablePullingLength} 米` },
        { label: '累計放筒長度', value: `${report.conduitLayingLength} 米` },
        { label: '累計探窿數量', value: `${report.trialPitCount} 個` },
        { label: '備註', value: report.remarks || '—' },
        { label: '最後更新', value: formatHktDateTime(report.updatedAt) },
    ]

    return (
        <>
            {!report.isValid && (
                <div className="report-detail-banner" role="status">
                    <ReportStatus report={report} />
                </div>
            )}
            {(report.messageIsEdited || report.messageIsDeleted) && (
                <div className="report-detail-flags">
                    <MessageFlags report={report} />
                </div>
            )}
            <dl className="report-sheet">
                {rows.map((row) => (
                    <div
                        className={`report-sheet-row${row.warn ? ' is-warn' : ''}`}
                        key={row.label}
                    >
                        <dt>{row.label}</dt>
                        <dd>{row.value}</dd>
                    </div>
                ))}
                {report.sourceText && (
                    <div className="report-sheet-row is-source">
                        <dt>原始訊息</dt>
                        <dd>
                            <pre className="report-sheet-source">{report.sourceText}</pre>
                        </dd>
                    </div>
                )}
            </dl>
            <div className="report-detail-actions">
                <button
                    type="button"
                    className="report-debug-trigger"
                    onClick={() => setDebugOpen(true)}
                >
                    Workflow debug
                </button>
                <button
                    type="button"
                    className="report-delete-trigger"
                    onClick={() => setDeleteOpen(true)}
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 7h16" />
                        <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        <path d="M10 11v6" />
                        <path d="M14 11v6" />
                        <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
                    </svg>
                    刪除報告
                </button>
            </div>
            <WorkflowDebugDialog
                open={debugOpen}
                messageId={report.messageId}
                onClose={() => setDebugOpen(false)}
                onReran={onReran}
            />
            <ReportDeleteDialog
                open={deleteOpen}
                report={report}
                onClose={() => setDeleteOpen(false)}
                onDeleted={(id) => {
                    setDeleteOpen(false)
                    onDeleted(id)
                }}
            />
        </>
    )
}

type WorkflowDebugResponse = {
    workflowsEnabled: boolean
    workflowsProcessHistory: boolean
    defaultModel: string
    models: string[]
    prompts: {
        classifierPrompt: string | null
        extractorPrompt: string | null
        promptsDir: string
    }
    snapshot: {
        message: {
            messageId: string
            groupJid: string
            groupName: string | null
            messageType: string
            textContent: string | null
            textLength: number
            mediaPath: string | null
            isDeleted: boolean
            isEdited: boolean
            isHistory: boolean
            isForwarded: boolean
            timestamp: number | null
        }
        runs: Array<{
            id: number
            workflowName: string
            event: string
            status: string
            detail: string | null
            createdAt: string
        }>
        reportId: number | null
    }
}

function WorkflowDebugDialog({
    open,
    messageId,
    onClose,
    onReran,
}: {
    open: boolean
    messageId: string
    onClose: () => void
    onReran?: () => void
}) {
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [data, setData] = useState<WorkflowDebugResponse | null>(null)
    const [adminPassword, setAdminPassword] = useState('')
    const [unlocked, setUnlocked] = useState(false)
    const [llmModel, setLlmModel] = useState('')
    const [classifierPrompt, setClassifierPrompt] = useState('')
    const [extractorPrompt, setExtractorPrompt] = useState('')
    const [baselineClassifier, setBaselineClassifier] = useState('')
    const [baselineExtractor, setBaselineExtractor] = useState('')
    const [rerunning, setRerunning] = useState(false)
    const [rerunNote, setRerunNote] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const busyRef = useRef(false)
    const promptsReadyRef = useRef(false)
    const onCloseRef = useRef(onClose)
    const onReranRef = useRef(onReran)
    onCloseRef.current = onClose
    onReranRef.current = onReran

    useEffect(() => {
        busyRef.current = loading || rerunning
    }, [loading, rerunning])

    useEffect(() => {
        if (!open) {
            if (pollRef.current) {
                clearInterval(pollRef.current)
                pollRef.current = null
            }
            setError(null)
            setRerunNote(null)
            setData(null)
            setUnlocked(false)
            setLlmModel('')
            setClassifierPrompt('')
            setExtractorPrompt('')
            setBaselineClassifier('')
            setBaselineExtractor('')
            setAdminPassword('')
            promptsReadyRef.current = false
            return
        }
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 40)

        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape' && !busyRef.current) onCloseRef.current()
        }
        window.addEventListener('keydown', onKey)
        return () => {
            document.body.style.overflow = previous
            window.removeEventListener('keydown', onKey)
            window.clearTimeout(focusTimer)
        }
    }, [open])

    useEffect(() => {
        return () => {
            if (pollRef.current) clearInterval(pollRef.current)
        }
    }, [])

    async function loadDebug(password: string) {
        setLoading(true)
        setError(null)
        try {
            const response = await fetch(
                `/api/debug/workflows?messageId=${encodeURIComponent(messageId)}&limit=12`,
                { headers: { 'x-admin-password': password } }
            )
            const body = (await response.json()) as WorkflowDebugResponse & { error?: string }
            if (!response.ok) {
                throw new Error(body.error || `Request failed (${response.status})`)
            }
            setData(body)
            setUnlocked(true)
            setLlmModel((current) => current || body.defaultModel)
            const nextClassifier = body.prompts.classifierPrompt ?? ''
            const nextExtractor = body.prompts.extractorPrompt ?? ''
            setBaselineClassifier(nextClassifier)
            setBaselineExtractor(nextExtractor)
            if (!promptsReadyRef.current) {
                setClassifierPrompt(nextClassifier)
                setExtractorPrompt(nextExtractor)
                promptsReadyRef.current = true
            }
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not load workflow debug')
            setData(null)
            setUnlocked(false)
        } finally {
            setLoading(false)
        }
    }

    async function handleUnlock(formEvent: { preventDefault(): void }) {
        formEvent.preventDefault()
        if (!adminPassword.trim()) {
            setError('Enter admin password')
            return
        }
        await loadDebug(adminPassword.trim())
    }

    async function handleRerun() {
        if (!adminPassword.trim()) {
            setError('Enter admin password')
            return
        }
        if (!llmModel.trim()) {
            setError('Select or enter a model id')
            return
        }
        if (!classifierPrompt.trim() || !extractorPrompt.trim()) {
            setError('Classifier and extractor prompts cannot be empty')
            return
        }
        setRerunning(true)
        setError(null)
        setRerunNote(null)
        const password = adminPassword.trim()
        try {
            const response = await fetch('/api/debug/workflows/reenqueue', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-password': password,
                },
                body: JSON.stringify({
                    messageId,
                    llmModel: llmModel.trim(),
                    classifierPrompt,
                    extractorPrompt,
                }),
            })
            const body = (await response.json()) as {
                error?: string
                llmModel?: string
            }
            if (!response.ok) {
                throw new Error(body.error || `Re-enqueue failed (${response.status})`)
            }
            setRerunNote(`Queued (${body.llmModel ?? llmModel}), waiting for worker…`)
            if (pollRef.current) clearInterval(pollRef.current)
            let attempts = 0
            pollRef.current = setInterval(() => {
                attempts += 1
                void loadDebug(password)
                if (attempts >= 12 && pollRef.current) {
                    clearInterval(pollRef.current)
                    pollRef.current = null
                    onReranRef.current?.()
                }
            }, 1500)
            window.setTimeout(() => {
                void loadDebug(password).then(() => onReranRef.current?.())
            }, 2500)
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not re-enqueue workflow')
        } finally {
            setRerunning(false)
        }
    }

    if (!open) return null

    const message = data?.snapshot.message
    const runs = data?.snapshot.runs ?? []
    const models = data?.models ?? []
    const promptsDirty =
        classifierPrompt !== baselineClassifier || extractorPrompt !== baselineExtractor

    return createPortal(
        <div
            className="workflow-debug-overlay"
            role="presentation"
            onClick={() => {
                if (!busyRef.current) onCloseRef.current()
            }}
        >
            <div
                className="workflow-debug-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="workflow-debug-title"
                onClick={(event) => event.stopPropagation()}
            >
                <header className="workflow-debug-dialog-header">
                    <div>
                        <h3 id="workflow-debug-title">Workflow debug</h3>
                        <p className="workflow-debug-dialog-summary">
                            Inspect workflow inputs and rerun this message
                        </p>
                    </div>
                    <button
                        type="button"
                        className="workflow-debug-dialog-close"
                        aria-label="Close"
                        disabled={loading || rerunning}
                        onClick={() => onCloseRef.current()}
                    >
                        ×
                    </button>
                </header>

                {!unlocked ? (
                    <form className="workflow-debug-unlock" onSubmit={handleUnlock}>
                        <label className="workflow-debug-password">
                            <span>Admin password</span>
                            <input
                                ref={inputRef}
                                type="password"
                                value={adminPassword}
                                autoComplete="current-password"
                                disabled={loading}
                                onChange={(change) => setAdminPassword(change.target.value)}
                            />
                        </label>
                        {error && <p className="workflow-debug-error">{error}</p>}
                        <div className="workflow-debug-dialog-actions">
                            <button
                                type="button"
                                className="workflow-debug-cancel"
                                disabled={loading}
                                onClick={() => onCloseRef.current()}
                            >
                                Cancel
                            </button>
                            <button type="submit" className="workflow-debug-submit" disabled={loading}>
                                {loading ? 'Loading…' : 'Unlock'}
                            </button>
                        </div>
                    </form>
                ) : (
                    <>
                        {error && <p className="workflow-debug-error">{error}</p>}
                        {rerunNote && <p className="workflow-debug-note">{rerunNote}</p>}

                        {message && (
                            <dl className="workflow-debug-meta">
                                <div>
                                    <dt>messageId</dt>
                                    <dd>
                                        <code>{message.messageId}</code>
                                    </dd>
                                </div>
                                <div>
                                    <dt>group</dt>
                                    <dd>
                                        {message.groupName || '—'}
                                        <span className="workflow-debug-muted">
                                            {' '}
                                            ({message.groupJid})
                                        </span>
                                    </dd>
                                </div>
                                <div>
                                    <dt>messageType</dt>
                                    <dd>{message.messageType}</dd>
                                </div>
                                <div>
                                    <dt>textLength</dt>
                                    <dd>
                                        {message.textLength}
                                        {message.textLength < 30 && (
                                            <span className="workflow-debug-warn">
                                                {' '}
                                                (&lt;30, LLM will be skipped)
                                            </span>
                                        )}
                                    </dd>
                                </div>
                                <div>
                                    <dt>flags</dt>
                                    <dd>
                                        {[
                                            message.isEdited ? 'edited' : null,
                                            message.isDeleted ? 'deleted' : null,
                                            message.isHistory ? 'history' : null,
                                            message.isForwarded ? 'forwarded' : null,
                                        ]
                                            .filter(Boolean)
                                            .join(' · ') || '—'}
                                    </dd>
                                </div>
                                <div>
                                    <dt>config</dt>
                                    <dd>
                                        workflows={data?.workflowsEnabled ? 'on' : 'off'}
                                        {' · '}
                                        history={data?.workflowsProcessHistory ? 'on' : 'off'}
                                        {' · '}
                                        reportId={data?.snapshot.reportId ?? '—'}
                                    </dd>
                                </div>
                            </dl>
                        )}

                        <div className="workflow-debug-input">
                            <div className="workflow-debug-input-label">LLM input (text_content)</div>
                            <pre>{message?.textContent?.trim() || '—'}</pre>
                        </div>

                        <label className="workflow-debug-model">
                            <span>Model id</span>
                            <input
                                list="workflow-debug-model-options"
                                value={llmModel}
                                disabled={rerunning}
                                placeholder={data?.defaultModel || 'model id'}
                                onChange={(change) => setLlmModel(change.target.value)}
                            />
                            <datalist id="workflow-debug-model-options">
                                {models.map((model) => (
                                    <option key={model} value={model} />
                                ))}
                            </datalist>
                        </label>

                        <div className="workflow-debug-prompts">
                            <div className="workflow-debug-runs-head">
                                <div className="workflow-debug-input-label">
                                    Prompts (this rerun only; not written to disk)
                                    {promptsDirty && (
                                        <span className="workflow-debug-warn"> · edited</span>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    className="workflow-debug-refresh"
                                    disabled={rerunning || !promptsDirty}
                                    onClick={() => {
                                        setClassifierPrompt(baselineClassifier)
                                        setExtractorPrompt(baselineExtractor)
                                    }}
                                >
                                    Reset
                                </button>
                            </div>
                            {!baselineClassifier && !baselineExtractor && (
                                <p className="workflow-debug-muted">
                                    Prompt files not found
                                    {data?.prompts.promptsDir
                                        ? ` (${data.prompts.promptsDir})`
                                        : ''}
                                    . You can still paste prompts and rerun.
                                </p>
                            )}
                            <label className="workflow-debug-prompt">
                                <span>classifier_prompt.txt</span>
                                <textarea
                                    value={classifierPrompt}
                                    disabled={rerunning}
                                    spellCheck={false}
                                    rows={8}
                                    onChange={(change) => setClassifierPrompt(change.target.value)}
                                />
                            </label>
                            <label className="workflow-debug-prompt">
                                <span>extractor_prompt.txt</span>
                                <textarea
                                    value={extractorPrompt}
                                    disabled={rerunning}
                                    spellCheck={false}
                                    rows={8}
                                    onChange={(change) => setExtractorPrompt(change.target.value)}
                                />
                            </label>
                        </div>

                        <div className="workflow-debug-runs">
                            <div className="workflow-debug-runs-head">
                                <div className="workflow-debug-input-label">Recent runs</div>
                                <button
                                    type="button"
                                    className="workflow-debug-refresh"
                                    disabled={loading || rerunning}
                                    onClick={() => void loadDebug(adminPassword.trim())}
                                >
                                    {loading ? 'Refreshing…' : 'Refresh'}
                                </button>
                            </div>
                            {runs.length === 0 ? (
                                <p className="workflow-debug-muted">No workflow_runs yet</p>
                            ) : (
                                <ul>
                                    {runs.map((run) => (
                                        <li key={run.id}>
                                            <span
                                                className={`workflow-debug-status status-${run.status}`}
                                            >
                                                {run.status}
                                            </span>
                                            <span className="workflow-debug-run-event">{run.event}</span>
                                            <span className="workflow-debug-run-name">
                                                {run.workflowName}
                                            </span>
                                            <time>{formatHktDateTime(run.createdAt)}</time>
                                            {run.detail && (
                                                <p className="workflow-debug-run-detail">{run.detail}</p>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        <div className="workflow-debug-dialog-actions">
                            <button
                                type="button"
                                className="workflow-debug-cancel"
                                disabled={loading || rerunning}
                                onClick={() => onCloseRef.current()}
                            >
                                Close
                            </button>
                            <button
                                type="button"
                                className="workflow-debug-submit"
                                disabled={rerunning || !data?.workflowsEnabled}
                                onClick={() => void handleRerun()}
                            >
                                {rerunning ? 'Queuing…' : 'Rerun'}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>,
        document.body
    )
}

function BulkWorkflowRerunDialog({
    open,
    total,
    from,
    to,
    groupJid,
    groupName,
    query,
    dateField,
    onClose,
    onDone,
}: {
    open: boolean
    total: number
    from: string
    to: string
    groupJid: string | null
    groupName: string | null
    query: string
    dateField: DailySiteReportDateField
    onClose: () => void
    onDone?: () => void
}) {
    const [adminPassword, setAdminPassword] = useState('')
    const [running, setRunning] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [resultNote, setResultNote] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const runningRef = useRef(false)
    const onCloseRef = useRef(onClose)
    runningRef.current = running
    onCloseRef.current = onClose

    useEffect(() => {
        if (!open) return undefined
        setAdminPassword('')
        setError(null)
        setResultNote(null)
        setRunning(false)
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 40)

        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape' && !runningRef.current) onCloseRef.current()
        }
        window.addEventListener('keydown', onKey)
        return () => {
            document.body.style.overflow = previous
            window.removeEventListener('keydown', onKey)
            window.clearTimeout(focusTimer)
        }
    }, [open])

    async function handleRerun() {
        if (!adminPassword.trim()) {
            setError('Enter admin password')
            return
        }
        if (total < 1) {
            setError('No reports match the current filters')
            return
        }
        setRunning(true)
        setError(null)
        setResultNote(null)
        try {
            const response = await fetch('/api/debug/workflows/reenqueue-filtered', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-password': adminPassword.trim(),
                },
                body: JSON.stringify({
                    from,
                    to,
                    dateField,
                    ...(groupJid ? { group: groupJid } : {}),
                    ...(query.trim() ? { q: query.trim() } : {}),
                }),
            })
            const body = (await response.json()) as {
                error?: string
                total?: number
                enqueued?: number
                failed?: string[]
                missing?: string[]
                maxRows?: number
            }
            if (!response.ok) {
                throw new Error(body.error || `Bulk re-enqueue failed (${response.status})`)
            }
            const failed = body.failed?.length ?? 0
            const missing = body.missing?.length ?? 0
            setResultNote(
                `Queued ${body.enqueued ?? 0} / ${body.total ?? total}` +
                    (failed || missing ? ` (failed ${failed}, missing ${missing})` : '')
            )
            onDone?.()
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not re-enqueue workflows')
        } finally {
            setRunning(false)
        }
    }

    if (!open) return null

    return createPortal(
        <div
            className="workflow-debug-overlay"
            role="presentation"
            onClick={() => {
                if (!running) onClose()
            }}
        >
            <div
                className="workflow-debug-dialog workflow-debug-dialog--bulk"
                role="dialog"
                aria-modal="true"
                aria-labelledby="bulk-workflow-rerun-title"
                onClick={(event) => event.stopPropagation()}
            >
                <header className="workflow-debug-dialog-header">
                    <div>
                        <h3 id="bulk-workflow-rerun-title">Rerun filtered workflows</h3>
                        <p className="workflow-debug-dialog-summary">
                            Rerun every report matching the current filters (max 500)
                        </p>
                    </div>
                    <button
                        type="button"
                        className="workflow-debug-dialog-close"
                        aria-label="Close"
                        disabled={running}
                        onClick={onClose}
                    >
                        ×
                    </button>
                </header>

                <dl className="workflow-debug-meta">
                    <div>
                        <dt>Range</dt>
                        <dd>
                            {from} → {to} (
                            {dateField === 'created' ? 'created date' : 'report date'})
                        </dd>
                    </div>
                    <div>
                        <dt>Group</dt>
                        <dd>{groupName || 'All groups'}</dd>
                    </div>
                    <div>
                        <dt>Search</dt>
                        <dd>{query.trim() || '—'}</dd>
                    </div>
                    <div>
                        <dt>Reports</dt>
                        <dd>{total}</dd>
                    </div>
                </dl>

                <label className="workflow-debug-password">
                    <span>Admin password</span>
                    <input
                        ref={inputRef}
                        type="password"
                        value={adminPassword}
                        autoComplete="current-password"
                        disabled={running}
                        onChange={(change) => setAdminPassword(change.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') void handleRerun()
                        }}
                    />
                </label>

                {error && <p className="workflow-debug-error">{error}</p>}
                {resultNote && <p className="workflow-debug-note">{resultNote}</p>}

                <div className="workflow-debug-dialog-actions">
                    <button
                        type="button"
                        className="workflow-debug-cancel"
                        disabled={running}
                        onClick={onClose}
                    >
                        {resultNote ? 'Close' : 'Cancel'}
                    </button>
                    <button
                        type="button"
                        className="workflow-debug-submit"
                        disabled={running || total < 1}
                        onClick={() => void handleRerun()}
                    >
                        {running ? 'Queuing…' : `Rerun ${total}`}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    )
}

export default function DailySiteReportView({
    from,
    to,
    groupJid,
    groupName,
    query,
    onQueryChange,
    dateField,
    onDateFieldChange,
    active,
    onLiveUpdate,
    onOpenGroups,
    groupsCollapsed,
}: {
    from: string
    to: string
    groupJid: string | null
    groupName: string | null
    query: string
    onQueryChange: (value: string) => void
    dateField: DailySiteReportDateField
    onDateFieldChange: (value: DailySiteReportDateField) => void
    active: boolean
    onLiveUpdate?: () => void
    onOpenGroups?: () => void
    groupsCollapsed?: boolean
}) {
    const [reports, setReports] = useState<DailySiteReport[]>([])
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [selected, setSelected] = useState<DailySiteReport | null>(null)
    const [bulkRerunOpen, setBulkRerunOpen] = useState(false)
    const [reloadKey, setReloadKey] = useState(0)
    const [visibleColumns, setVisibleColumns] = useState(readVisibleReportColumns)
    const [sort, setSort] = useState<ReportSortState>(() => readReportSort(dateField))
    const [queryInput, setQueryInput] = useState(query)
    const requestId = useRef(0)
    const scrollRef = useRef<HTMLDivElement>(null)
    const silentBusy = useRef(false)
    const modalBusy = useRef(false)
    const hasRowsRef = useRef(false)
    hasRowsRef.current = reports.length > 0

    const handleModalOpenChange = useCallback((open: boolean) => {
        modalBusy.current = open
    }, [])

    useEffect(() => {
        modalBusy.current = bulkRerunOpen
    }, [bulkRerunOpen])

    useEffect(() => {
        setQueryInput(query)
    }, [query])

    useEffect(() => {
        if (queryInput === query) return undefined
        const timer = window.setTimeout(() => onQueryChange(queryInput), 300)
        return () => window.clearTimeout(timer)
    }, [query, queryInput, onQueryChange])

    const buildUrl = useCallback(
        (cursor?: string | null) => {
            const params = new URLSearchParams({
                from,
                to,
                dateField,
                sortBy: sort.sortBy,
                sortDir: sort.sortDir,
            })
            if (groupJid) params.set('group', groupJid)
            if (query.trim()) params.set('q', query.trim())
            if (cursor) params.set('cursor', cursor)
            return `/api/daily-site-reports?${params}`
        },
        [from, to, groupJid, query, dateField, sort]
    )

    useEffect(() => {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(REPORT_TABLE_SORT_STORAGE_KEY, JSON.stringify(sort))
    }, [sort])

    useEffect(() => {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(
            REPORT_TABLE_COLUMNS_STORAGE_KEY,
            JSON.stringify([...visibleColumns])
        )
    }, [visibleColumns])

    function toggleSort(columnId: ReportTableColumnId) {
        setSort((current) => {
            if (current.sortBy === columnId) {
                return {
                    sortBy: columnId,
                    sortDir: current.sortDir === 'asc' ? 'desc' : 'asc',
                }
            }
            return { sortBy: columnId, sortDir: 'desc' }
        })
    }

    const activeColumns = REPORT_TABLE_COLUMNS.filter((column) => visibleColumns.has(column.id))

    useEffect(() => {
        if (!active) return undefined
        const controller = new AbortController()
        const id = ++requestId.current
        if (!hasRowsRef.current) setLoading(true)
        setError(null)
        getJson<ReportsResponse>(buildUrl(), controller.signal)
            .then((data) => {
                if (id !== requestId.current) return
                setReports(data.reports)
                setNextCursor(data.nextCursor)
                setTotal(data.total)
            })
            .catch((reason: unknown) => {
                if (id !== requestId.current || (reason as Error).name === 'AbortError') return
                setError(reason instanceof Error ? reason.message : 'Could not load reports')
            })
            .finally(() => {
                if (id === requestId.current) setLoading(false)
            })
        return () => controller.abort()
    }, [active, buildUrl, reloadKey])

    async function loadMore() {
        if (!nextCursor || loadingMore) return
        setLoadingMore(true)
        try {
            const data = await getJson<ReportsResponse>(buildUrl(nextCursor))
            setReports((current) => [...current, ...data.reports])
            setNextCursor(data.nextCursor)
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not load more reports')
        } finally {
            setLoadingMore(false)
        }
    }

    async function silentRefresh() {
        if (!active || loading || loadingMore || silentBusy.current || modalBusy.current) return
        silentBusy.current = true
        try {
            const data = await getJson<ReportsResponse>(buildUrl())
            setReports(data.reports)
            setNextCursor(data.nextCursor)
            setTotal(data.total)
            setError(null)
            onLiveUpdate?.()
        } catch {
            // ignore background refresh errors
        } finally {
            silentBusy.current = false
        }
    }

    useVisibleInterval(silentRefresh, active ? 15_000 : null)

    const sentinelRef = useInfiniteScroll(
        scrollRef,
        () => {
            void loadMore()
        },
        active && Boolean(nextCursor) && !loadingMore && !loading,
        'desc'
    )

    const dateRangeHint =
        dateField === 'created'
            ? '以建立日期篩選 — 可對照報告日期找出填錯日期的記錄'
            : '以報告日期篩選'

    return (
        <section className="reports-panel">
            <header className="reports-heading">
                <div className="reports-heading-row">
                    {groupsCollapsed && onOpenGroups && (
                        <button
                            type="button"
                            className="groups-panel-toggle groups-panel-toggle--open desktop-only"
                            onClick={onOpenGroups}
                            title="Show groups"
                            aria-label="Show groups"
                        >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="m9 6 6 6-6 6" />
                            </svg>
                        </button>
                    )}
                    <div className="reports-heading-body">
                        <div className="reports-heading-main">
                            <div className="reports-heading-text">
                                <h2>每日工地報告</h2>
                                <div className="reports-meta">
                                    <span className="reports-meta-pill">
                                        {groupName || 'All groups'}
                                    </span>
                                    <span className="reports-meta-pill">
                                        {total} report{total === 1 ? '' : 's'}
                                    </span>
                                    <span className="reports-meta-hint" title={dateRangeHint}>
                                        {dateField === 'created' ? '建立日期' : '報告日期'}
                                    </span>
                                </div>
                            </div>
                            <div className="reports-heading-actions">
                                <button
                                    type="button"
                                    className="reports-bulk-rerun"
                                    disabled={total < 1}
                                    onClick={() => setBulkRerunOpen(true)}
                                >
                                    Rerun
                                </button>
                                <a
                                    className="reports-export"
                                    href={exportUrl(from, to, groupJid, query, dateField, sort)}
                                    download
                                >
                                    <svg viewBox="0 0 24 24" aria-hidden="true">
                                        <path d="M12 3v12" />
                                        <path d="m7 10 5 5 5-5" />
                                        <path d="M5 21h14" />
                                    </svg>
                                    CSV
                                </a>
                            </div>
                        </div>
                        <div className="reports-toolbar">
                            <div className="reports-date-filter" role="group" aria-label="日期篩選">
                                <button
                                    type="button"
                                    className={dateField === 'report' ? 'active' : ''}
                                    aria-pressed={dateField === 'report'}
                                    onClick={() => onDateFieldChange('report')}
                                >
                                    報告日期
                                </button>
                                <button
                                    type="button"
                                    className={dateField === 'created' ? 'active' : ''}
                                    aria-pressed={dateField === 'created'}
                                    onClick={() => onDateFieldChange('created')}
                                >
                                    建立日期
                                </button>
                            </div>
                            <ReportColumnPicker
                                visibleColumns={visibleColumns}
                                onChange={setVisibleColumns}
                            />
                            <label className="search-box reports-search">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <circle cx="11" cy="11" r="7" />
                                    <path d="m20 20-4-4" />
                                </svg>
                                <input
                                    type="search"
                                    placeholder="Search PO, contractor, ref…"
                                    value={queryInput}
                                    onChange={(event) => setQueryInput(event.target.value)}
                                />
                            </label>
                        </div>
                    </div>
                </div>
            </header>

            {error && (
                <div className="reports-error" role="alert">
                    <span>{error}</span>
                    <button type="button" onClick={() => setReloadKey((key) => key + 1)}>
                        Retry
                    </button>
                </div>
            )}

            <div
                className={`reports-table-wrap${loading ? ' is-loading' : ''}`}
                ref={scrollRef}
            >
                {loading && reports.length === 0 ? (
                    <div className="reports-skeleton" aria-label="Loading reports">
                        {[1, 2, 3, 4].map((row) => (
                            <div
                                className="skeleton reports-skeleton-row desktop-only"
                                key={row}
                            />
                        ))}
                        {[1, 2, 3].map((row) => (
                            <div
                                className="skeleton reports-skeleton-card mobile-only"
                                key={`card-${row}`}
                            />
                        ))}
                    </div>
                ) : reports.length ? (
                    <>
                        <div className="reports-mobile-list mobile-only" aria-label="Daily site reports">
                            {reports.map((report) => (
                                <ReportMobileCard
                                    key={report.id}
                                    report={report}
                                    onSelect={() => setSelected(report)}
                                />
                            ))}
                        </div>
                        <table className="reports-table reports-table--modern desktop-only">
                        <thead>
                            <tr>
                                {activeColumns.map((column) => (
                                    <ReportTableHeader
                                        key={column.id}
                                        className={column.className}
                                        label={column.label}
                                        title={column.title}
                                        sortable={column.sortable !== false}
                                        sortDir={sort.sortBy === column.id ? sort.sortDir : null}
                                        onSort={() => toggleSort(column.id)}
                                    />
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {reports.map((report) => (
                                <tr
                                    key={report.id}
                                    className={`report-row${report.isValid ? '' : ' report-row--invalid'}`}
                                    onClick={() => setSelected(report)}
                                >
                                    {activeColumns.map((column) =>
                                        renderReportTableCell(report, column.id)
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    </>
                ) : (
                    <div className="empty-state compact">
                        <h3>No site reports in this range</h3>
                        <p>
                            Reports appear when the workflow classifies WhatsApp messages as daily
                            site reports.
                        </p>
                    </div>
                )}
                {loading && reports.length > 0 && (
                    <div className="content-overlay" role="status">
                        <span className="overlay-spinner" />
                        Loading
                    </div>
                )}
                {nextCursor && (
                    <div className="load-sentinel reports-sentinel" ref={sentinelRef}>
                        {loadingMore ? 'Loading…' : ''}
                    </div>
                )}
            </div>

            <Drawer
                open={Boolean(selected)}
                onClose={() => setSelected(null)}
                title={selected?.projectName || '工地報告'}
                subtitle={selected ? drawerSubtitle(selected) : undefined}
                panelClassName="drawer-panel--report"
                bodyClassName="drawer-body--report"
            >
                {selected && (
                    <ReportDetail
                        report={selected}
                        onModalOpenChange={handleModalOpenChange}
                        onDeleted={(id) => {
                            setReports((current) => current.filter((item) => item.id !== id))
                            setTotal((current) => Math.max(0, current - 1))
                            setSelected(null)
                            onLiveUpdate?.()
                        }}
                        onReran={() => {
                            setReloadKey((key) => key + 1)
                            onLiveUpdate?.()
                        }}
                    />
                )}
            </Drawer>
            <BulkWorkflowRerunDialog
                open={bulkRerunOpen}
                total={total}
                from={from}
                to={to}
                groupJid={groupJid}
                groupName={groupName}
                query={query}
                dateField={dateField}
                onClose={() => setBulkRerunOpen(false)}
                onDone={() => {
                    setReloadKey((key) => key + 1)
                    onLiveUpdate?.()
                }}
            />
        </section>
    )
}
