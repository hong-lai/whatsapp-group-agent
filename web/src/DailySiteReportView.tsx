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
    actualNumWorkers: number | null
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

type ReportTableColumnId =
    | 'reportDate'
    | 'po'
    | 'ref'
    | 'contractor'
    | 'project'
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
    | 'flags'

type ReportTableColumn = {
    id: ReportTableColumnId
    className?: string
    label: string
    title?: string
}

const REPORT_TABLE_COLUMNS: ReportTableColumn[] = [
    { id: 'reportDate', className: 'col-date', label: '報告日期' },
    { id: 'po', className: 'col-po', label: 'PO' },
    { id: 'ref', label: 'Ref' },
    { id: 'contractor', label: '承辦商' },
    { id: 'project', className: 'col-project', label: '項目名稱' },
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
    { id: 'flags', className: 'col-flags', label: '訊息' },
]

const REPORT_TABLE_COLUMN_IDS = REPORT_TABLE_COLUMNS.map((column) => column.id)

function readVisibleReportColumns(): Set<ReportTableColumnId> {
    const defaults = new Set(REPORT_TABLE_COLUMN_IDS)
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
        case 'flags':
            return (
                <td key={columnId} className="col-flags">
                    <MessageFlags report={report} compact />
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
}: {
    label: string
    title?: string
    className?: string
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

    return (
        <th ref={ref} className={className} onMouseEnter={syncTitle}>
            {label}
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
    dateField: DailySiteReportDateField
): string {
    const params = new URLSearchParams({ from, to, dateField })
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
    deletingRef.current = deleting

    useEffect(() => {
        if (!open) return undefined
        setAdminPassword('')
        setDeleteError(null)
        setDeleting(false)
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        inputRef.current?.focus()

        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape' && !deletingRef.current) onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => {
            document.body.style.overflow = previous
            window.removeEventListener('keydown', onKey)
        }
    }, [open, onClose])

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
}: {
    report: DailySiteReport
    onDeleted: (id: number) => void
}) {
    const [deleteOpen, setDeleteOpen] = useState(false)

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
            <div className="report-delete-panel">
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
    const [reloadKey, setReloadKey] = useState(0)
    const [visibleColumns, setVisibleColumns] = useState(readVisibleReportColumns)
    const [queryInput, setQueryInput] = useState(query)
    const requestId = useRef(0)
    const scrollRef = useRef<HTMLDivElement>(null)
    const silentBusy = useRef(false)
    const hasRowsRef = useRef(false)
    hasRowsRef.current = reports.length > 0

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
            const params = new URLSearchParams({ from, to, dateField })
            if (groupJid) params.set('group', groupJid)
            if (query.trim()) params.set('q', query.trim())
            if (cursor) params.set('cursor', cursor)
            return `/api/daily-site-reports?${params}`
        },
        [from, to, groupJid, query, dateField]
    )

    useEffect(() => {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(
            REPORT_TABLE_COLUMNS_STORAGE_KEY,
            JSON.stringify([...visibleColumns])
        )
    }, [visibleColumns])

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
        if (!active || loading || loadingMore || silentBusy.current) return
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
                <div className="reports-heading-main">
                    <div className="reports-heading-title">
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
                        <div className="reports-heading-text">
                            <h2>每日工地報告</h2>
                            <div className="reports-meta">
                                <span className="reports-meta-pill">
                                    {groupName || 'All groups'}
                                </span>
                                <span className="reports-meta-pill">
                                    {total} report{total === 1 ? '' : 's'}
                                </span>
                                <span className="reports-meta-hint">{dateRangeHint}</span>
                            </div>
                        </div>
                    </div>
                    <a
                        className="reports-export"
                        href={exportUrl(from, to, groupJid, query, dateField)}
                        download
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M12 3v12" />
                            <path d="m7 10 5 5 5-5" />
                            <path d="M5 21h14" />
                        </svg>
                        Export CSV
                    </a>
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
                        onDeleted={(id) => {
                            setReports((current) => current.filter((item) => item.id !== id))
                            setTotal((current) => Math.max(0, current - 1))
                            setSelected(null)
                            onLiveUpdate?.()
                        }}
                    />
                )}
            </Drawer>
        </section>
    )
}
