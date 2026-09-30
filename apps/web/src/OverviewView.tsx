import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { adminHeaders, useAdminAuth } from './adminAuth'
import { useVisibleInterval } from './useVisibleInterval'

type ReportTone = 'ok' | 'issue' | 'none'

type OverviewGroup = {
    jid: string
    name: string
    messageCount: number
    media: {
        conversation: number
        document: number
        image: number
        video: number
    }
    topParticipant: {
        name: string
        messageCount: number
        share: number
    } | null
    dailySiteReport: {
        count: number
        issueCount: number
        errorCount: number
    }
    inReportSection?: boolean
}

type OverviewSection = {
    id: string
    title: string | null
    groups: OverviewGroup[]
}

type OverviewResponse = {
    groups: OverviewGroup[]
    error?: string
}

const MEDIA_STATS = [
    { key: 'conversation', label: 'Conversation' },
    { key: 'document', label: 'Document' },
    { key: 'image', label: 'Image' },
    { key: 'video', label: 'Video' },
] as const

type OverviewLayout = 'cards' | 'table'

function readLayout(): OverviewLayout {
    try {
        return sessionStorage.getItem('overview-layout') === 'table' ? 'table' : 'cards'
    } catch {
        return 'cards'
    }
}

function reportTone(group: OverviewGroup): ReportTone {
    if (group.dailySiteReport.count === 0) return 'none'
    if (group.dailySiteReport.issueCount > 0) return 'issue'
    return 'ok'
}

function reportLabel(tone: ReportTone): string {
    if (tone === 'issue') return 'Daily site report, needs review'
    if (tone === 'ok') return 'Daily site report, clear'
    return 'Daily site report, none'
}

function groupIsEmpty(group: OverviewGroup): boolean {
    return group.messageCount === 0 && group.dailySiteReport.count === 0 && group.dailySiteReport.errorCount === 0
}

type MediaTotals = {
    reports: number
    conversation: number
    document: number
    image: number
    video: number
}

function sumGroups(groups: OverviewGroup[]): MediaTotals {
    const totals: MediaTotals = { reports: 0, conversation: 0, document: 0, image: 0, video: 0 }
    for (const group of groups) {
        totals.reports += group.dailySiteReport.count
        totals.conversation += group.media.conversation
        totals.document += group.media.document
        totals.image += group.media.image
        totals.video += group.media.video
    }
    return totals
}

function isAbort(reason: unknown): boolean {
    return reason instanceof Error && reason.name === 'AbortError'
}

export default function OverviewView({
    from,
    to,
    active,
    liveTick,
    showEmptyGroups,
    onToggleEmpty,
    onOpenGroup,
    onOpenReports,
}: {
    from: string
    to: string
    active: boolean
    liveTick: number
    showEmptyGroups: boolean
    onToggleEmpty: () => void
    onOpenGroup: (jid: string) => void
    onOpenReports: (jid: string) => void
}) {
    const [data, setData] = useState<OverviewResponse | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [layout, setLayout] = useState<OverviewLayout>(readLayout)
    const [editorOpen, setEditorOpen] = useState(false)
    const { role, adminPassword } = useAdminAuth()
    const isAdmin = role === 'admin' && Boolean(adminPassword)
    const requestId = useRef(0)

    const chooseLayout = (next: OverviewLayout) => {
        setLayout(next)
        try {
            sessionStorage.setItem('overview-layout', next)
        } catch {
            // The choice still applies for this visit.
        }
    }

    const load = useCallback(
        async (signal?: AbortSignal) => {
            const id = ++requestId.current
            try {
                const response = await fetch(
                    `/api/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
                    { signal }
                )
                const body = (await response.json()) as OverviewResponse
                if (id !== requestId.current) return
                if (!response.ok) throw new Error(body.error || `Could not load overview (${response.status})`)
                setData(body)
                setError(null)
            } catch (reason) {
                if (id !== requestId.current || isAbort(reason)) return
                setError(reason instanceof Error ? reason.message : 'Could not load overview')
            } finally {
                if (id === requestId.current) setLoading(false)
            }
        },
        [from, to]
    )

    useEffect(() => {
        const controller = new AbortController()
        setLoading(true)
        void load(controller.signal)
        return () => controller.abort()
    }, [load, liveTick])

    useVisibleInterval(() => {
        void load()
    }, active ? 15_000 : null)

    const groups = data?.groups ?? []
    const reportGroups = useMemo(() => groups.filter((group) => group.inReportSection), [groups])
    const otherGroups = useMemo(
        () => groups.filter((group) => !group.inReportSection && (showEmptyGroups || !groupIsEmpty(group))),
        [groups, showEmptyGroups]
    )
    const sections = useMemo<OverviewSection[]>(() => {
        if (reportGroups.length === 0) {
            return [{ id: 'all', title: null, groups: otherGroups }]
        }
        const next: OverviewSection[] = [{ id: 'reports', title: 'Site reports', groups: reportGroups }]
        if (otherGroups.length > 0) next.push({ id: 'other', title: 'Other groups', groups: otherGroups })
        return next
    }, [otherGroups, reportGroups])

    return (
        <section className="overview-panel" aria-busy={loading && !data}>
            <div className="overview-bar">
                <div className="overview-layout" role="group" aria-label="Overview layout">
                    <button type="button" aria-pressed={layout === 'cards'} onClick={() => chooseLayout('cards')}>
                        Cards
                    </button>
                    <button type="button" aria-pressed={layout === 'table'} onClick={() => chooseLayout('table')}>
                        Table
                    </button>
                </div>
                <div className="overview-bar-actions">
                    {isAdmin && (
                        <button type="button" className="empty-groups-toggle" onClick={() => setEditorOpen(true)}>
                            {reportGroups.length > 0 ? `Report groups ${reportGroups.length}` : 'Report groups'}
                        </button>
                    )}
                <button
                    type="button"
                    className={`empty-groups-toggle ${showEmptyGroups ? 'active' : ''}`}
                    aria-pressed={showEmptyGroups}
                    title={
                        showEmptyGroups
                            ? 'Hide groups with no messages or site reports in this range'
                            : 'Show groups with no messages or site reports in this range'
                    }
                    onClick={onToggleEmpty}
                >
                    {showEmptyGroups ? 'Hide empty' : 'Show empty'}
                </button>
                </div>
            </div>

            {error && (
                <p className="overview-banner is-error" role="alert">
                    <span>{error}</span>
                    <button type="button" onClick={() => void load()}>
                        Try again
                    </button>
                </p>
            )}

            {loading && !data ? (
                layout === 'table' ? (
                    <div className="overview-table-wrap" aria-hidden="true">
                        {Array.from({ length: 8 }, (_, item) => (
                            <div className="overview-table-skeleton skeleton" key={item} />
                        ))}
                    </div>
                ) : (
                    <div className="overview-board" aria-hidden="true">
                        {Array.from({ length: 6 }, (_, item) => (
                            <div className="overview-card skeleton" key={item} />
                        ))}
                    </div>
                )
            ) : reportGroups.length === 0 && otherGroups.length === 0 ? (
                <p className="overview-empty">
                    {groups.length === 0
                        ? 'No active groups match the configured name pattern.'
                        : 'No active groups have messages or site reports in this range.'}
                </p>
            ) : layout === 'table' ? (
                        <div className="overview-table-stack">
                            <MetricBoard
                                label="All groups"
                                tone="total"
                                totals={sumGroups(sections.flatMap((section) => section.groups))}
                            />
                            {sections.map((section) => (
                                <section key={section.id} aria-label={section.title ?? 'Groups'}>
                                    {section.title && (
                                        <MetricBoard
                                            label={section.title}
                                            count={section.groups.length}
                                            tone="subtotal"
                                            totals={sumGroups(section.groups)}
                                        />
                                    )}
                                    <GroupTable
                                        groups={section.groups}
                                        onOpenGroup={onOpenGroup}
                                        onOpenReports={onOpenReports}
                                    />
                                </section>
                            ))}
                        </div>
                    ) : (
                        <div className="overview-sections">
                            <MetricBoard
                                label="All groups"
                                tone="total"
                                totals={sumGroups(sections.flatMap((section) => section.groups))}
                            />
                            {sections.map((section) => (
                                <section key={section.id} aria-label={section.title ?? 'Groups'}>
                                    {section.title && (
                                        <MetricBoard
                                            label={section.title}
                                            count={section.groups.length}
                                            tone="subtotal"
                                            totals={sumGroups(section.groups)}
                                        />
                                    )}
                                    <div className="overview-board">
                                        {section.groups.map((group) => (
                                            <GroupCard
                                                key={group.jid}
                                                group={group}
                                                onOpenGroup={() => onOpenGroup(group.jid)}
                                                onOpenReports={() => onOpenReports(group.jid)}
                                            />
                                        ))}
                                    </div>
                                </section>
                            ))}
                        </div>
                    )}
            {editorOpen && isAdmin && adminPassword && (
                <ReportSectionDialog
                    groups={groups}
                    password={adminPassword}
                    onClose={() => setEditorOpen(false)}
                    onSaved={(jids) => {
                        const selected = new Set(jids)
                        setData((current) =>
                            current
                                ? {
                                      ...current,
                                      groups: current.groups.map((group) => ({
                                          ...group,
                                          inReportSection: selected.has(group.jid),
                                      })),
                                  }
                                : current
                        )
                        setEditorOpen(false)
                    }}
                />
            )}
        </section>
    )
}

function GroupTable({
    groups,
    onOpenGroup,
    onOpenReports,
}: {
    groups: OverviewGroup[]
    onOpenGroup: (jid: string) => void
    onOpenReports: (jid: string) => void
}) {
    return (
        <div className="overview-table-wrap">
            <table className="overview-table">
                <caption>Active groups</caption>
                <thead>
                    <tr>
                        <th scope="col">Group</th>
                        <th scope="col">Site report</th>
                        {MEDIA_STATS.map((stat) => (
                            <th key={stat.key} scope="col" className="is-num">
                                {stat.label}
                            </th>
                        ))}
                        <th scope="col">Most active</th>
                    </tr>
                </thead>
                <tbody>
                    {groups.map((group) => {
                            const tone = reportTone(group)
                            const participant = group.topParticipant
                            return (
                                <tr key={group.jid}>
                                    <th scope="row">
                                        <button type="button" onClick={() => onOpenGroup(group.jid)}>
                                            <span title={group.name}>{group.name}</span>
                                        </button>
                                    </th>
                                    <td>
                                        {tone === 'none' ? (
                                            <span className="overview-table-report is-none">None</span>
                                        ) : (
                                            <button
                                                type="button"
                                                className={`overview-table-report is-${tone}`}
                                                aria-label={`${reportLabel(tone)} for ${group.name}`}
                                                onClick={() => onOpenReports(group.jid)}
                                            >
                                                <ReportMark tone={tone} />
                                            </button>
                                        )}
                                    </td>
                                    {MEDIA_STATS.map((stat) => (
                                        <td key={stat.key} className="is-num">
                                            {group.media[stat.key]}
                                        </td>
                                    ))}
                                    <td>
                                        {participant ? (
                                            <span className="overview-table-person">
                                                <span title={participant.name}>{participant.name}</span>
                                                <em>{participant.share}%</em>
                                            </span>
                                    ) : (
                                        <span className="overview-table-empty">—</span>
                                    )}
                                    </td>
                                </tr>
                            )
                        })}
                </tbody>
            </table>
        </div>
    )
}

function MetricBoard({
    label,
    count,
    tone,
    totals,
}: {
    label: string
    count?: number
    tone: 'total' | 'subtotal'
    totals: MediaTotals
}) {
    const figures: { key: MetricIconKind; label: string; value: number }[] = [
        { key: 'reports', label: 'Reports', value: totals.reports },
        ...MEDIA_STATS.map((stat) => ({
            key: stat.key,
            label: stat.label,
            value: totals[stat.key],
        })),
    ]
    return (
        <header className={`overview-metrics is-${tone}`}>
            <div className="overview-metrics-title">
                <p>{tone === 'total' ? 'Total' : 'Subtotal'}</p>
                <h2>
                    {label}
                    {count != null && <span>{count}</span>}
                </h2>
            </div>
            <dl>
                {figures.map((figure) => (
                    <div key={figure.key} title={figure.label}>
                        <dt>
                            <MetricIcon kind={figure.key} />
                            <span className="overview-count-name">{figure.label}</span>
                        </dt>
                        <dd>{figure.value}</dd>
                    </div>
                ))}
            </dl>
        </header>
    )
}

function ReportSectionDialog({
    groups,
    password,
    onClose,
    onSaved,
}: {
    groups: OverviewGroup[]
    password: string
    onClose: () => void
    onSaved: (jids: string[]) => void
}) {
    const [selected, setSelected] = useState(() => new Set(groups.filter((group) => group.inReportSection).map((group) => group.jid)))
    const [query, setQuery] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const needle = query.trim().toLocaleLowerCase()
    const listed = useMemo(
        () =>
            [...groups]
                .filter((group) => !needle || group.name.toLocaleLowerCase().includes(needle))
                .sort((left, right) => left.name.localeCompare(right.name, 'zh-HK')),
        [groups, needle]
    )

    const toggle = (jid: string) => {
        setSelected((current) => {
            const next = new Set(current)
            if (next.has(jid)) next.delete(jid)
            else next.add(jid)
            return next
        })
    }

    const save = async () => {
        setSaving(true)
        setError(null)
        try {
            const response = await fetch('/api/overview/report-section', {
                method: 'PUT',
                headers: adminHeaders(password, true),
                body: JSON.stringify({ jids: [...selected] }),
            })
            const body = (await response.json()) as { jids?: string[]; error?: string }
            if (!response.ok) throw new Error(body.error || `Could not save report groups (${response.status})`)
            onSaved(body.jids ?? [...selected])
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not save report groups')
            setSaving(false)
        }
    }

    return (
        <div
            className="settings-overlay"
            role="presentation"
            onClick={() => {
                if (!saving) onClose()
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape' && !saving) onClose()
            }}
        >
            <div
                className="settings-panel overview-section-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="overview-section-title"
                onClick={(event) => event.stopPropagation()}
            >
                <header className="settings-header">
                    <div>
                        <h2 id="overview-section-title">Report groups</h2>
                        <p>Groups you add here stay in the site report section, including days with no report.</p>
                    </div>
                    <button type="button" className="settings-close" aria-label="Close" disabled={saving} onClick={onClose}>
                        ×
                    </button>
                </header>
                <label className="overview-section-filter">
                    <span>Filter</span>
                    <input
                        type="search"
                        value={query}
                        placeholder="Group name"
                        autoFocus
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </label>
                <ul className="overview-section-list">
                    {listed.map((group) => (
                        <li key={group.jid}>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={selected.has(group.jid)}
                                    onChange={() => toggle(group.jid)}
                                />
                                <span title={group.name}>{group.name}</span>
                            </label>
                        </li>
                    ))}
                    {listed.length === 0 && <li className="overview-section-none">No matching groups.</li>}
                </ul>
                {error && (
                    <p className="overview-section-error" role="alert">
                        {error}
                    </p>
                )}
                <footer className="overview-section-actions">
                    <span>{selected.size} selected</span>
                    <button type="button" disabled={saving} onClick={onClose}>
                        Cancel
                    </button>
                    <button type="button" className="overview-section-save" disabled={saving} onClick={() => void save()}>
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </footer>
            </div>
        </div>
    )
}

function GroupCard({
    group,
    onOpenGroup,
    onOpenReports,
}: {
    group: OverviewGroup
    onOpenGroup: () => void
    onOpenReports: () => void
}) {
    const tone = reportTone(group)
    const participant = group.topParticipant
    return (
        <article className="overview-card">
            <button type="button" className="overview-card-title" onClick={onOpenGroup}>
                <strong title={group.name}>{group.name}</strong>
            </button>
            {tone === 'none' ? (
                <div className="overview-report is-none">
                    <ReportMark tone="none" />
                    <span>Daily site report</span>
                    <em>None</em>
                </div>
            ) : (
                <button
                    type="button"
                    className={`overview-report is-${tone}`}
                    aria-label={`${reportLabel(tone)} for ${group.name}`}
                    onClick={onOpenReports}
                >
                    <ReportMark tone={tone} />
                    <span>Daily site report</span>
                </button>
            )}
            <dl className="overview-counts">
                {MEDIA_STATS.map((stat) => (
                    <div key={stat.key}>
                        <dt>
                            <MediaGlyph kind={stat.key} />
                            <span className="overview-count-name">{stat.label}</span>
                        </dt>
                        <dd>{group.media[stat.key]}</dd>
                    </div>
                ))}
            </dl>
            {participant && (
                <div className="overview-participant">
                    <span>Most active</span>
                    <strong title={participant.name}>{participant.name}</strong>
                    <em>{participant.share}%</em>
                    <span
                        className="overview-share"
                        style={{ '--share': `${participant.share}%` } as CSSProperties}
                        aria-hidden="true"
                    />
                </div>
            )}
        </article>
    )
}

function ReportMark({ tone }: { tone: ReportTone }) {
    return (
        <span className={`overview-report-mark is-${tone}`} aria-hidden="true">
            <svg viewBox="0 0 24 24">
                <path d="M7 3.5h6.5L18 8v12.2a1.3 1.3 0 0 1-1.3 1.3H7.3A1.3 1.3 0 0 1 6 20.2V4.8A1.3 1.3 0 0 1 7.3 3.5H7z" />
                <path d="M13.5 3.8V8H18" />
                <path d="M9 12.5h6M9 16h3.5" />
            </svg>
            {tone !== 'none' && (
                <svg className="overview-report-tick" viewBox="0 0 16 16">
                    <circle cx="8" cy="8" r="7" />
                    <path d="m4.8 8.2 2.1 2.1 4.3-4.4" />
                </svg>
            )}
        </span>
    )
}

type MetricIconKind = 'reports' | (typeof MEDIA_STATS)[number]['key']

function MetricIcon({ kind }: { kind: MetricIconKind }) {
    if (kind === 'reports') {
        return (
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 3.5h6.5L18 8v12.2a1.3 1.3 0 0 1-1.3 1.3H7.3A1.3 1.3 0 0 1 6 20.2V4.8A1.3 1.3 0 0 1 7.3 3.5H7z" />
                <path d="M13.5 3.8V8H18" />
                <path d="M9 12.5h6M9 16h3.5" />
            </svg>
        )
    }
    return <MediaGlyph kind={kind} />
}

function MediaGlyph({ kind }: { kind: (typeof MEDIA_STATS)[number]['key'] }) {
    const paths = {
        conversation: <path d="M5 16.5 2.5 19V6.2A2.2 2.2 0 0 1 4.7 4h14.6A2.2 2.2 0 0 1 21.5 6.2v7.1a2.2 2.2 0 0 1-2.2 2.2H5z" />,
        document: (
            <>
                <path d="M7 3.5h6.2L19 9.2V19a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7.5 3.5H7z" />
                <path d="M13 3.8V9h5.2" />
            </>
        ),
        image: (
            <>
                <rect x="4" y="5" width="16" height="14" rx="2" />
                <circle cx="9" cy="10" r="1.4" />
                <path d="m20 16-4.2-4.2-3.2 3.2L10 12.5 4 18" />
            </>
        ),
        video: (
            <>
                <rect x="3.5" y="6" width="12" height="12" rx="2" />
                <path d="m15.5 10.5 5-2.5v8l-5-2.5z" />
            </>
        ),
    }
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            {paths[kind]}
        </svg>
    )
}
