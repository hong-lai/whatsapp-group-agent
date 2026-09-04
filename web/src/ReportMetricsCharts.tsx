import { useEffect, useId, useState } from 'react'
import {
    Area,
    AreaChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts'

type DailySiteReportDateField = 'report' | 'created'

export type MetricsSeriesPoint = {
    date: string
    trenchLength: number
    coringLength: number
    cablePullingLength: number
    conduitLayingLength: number
    trialPitCount: number
    reportCount: number
}

type MetricsSeriesResponse = {
    points: MetricsSeriesPoint[]
    dateField: DailySiteReportDateField
}

type MetricKey = keyof Pick<
    MetricsSeriesPoint,
    | 'trenchLength'
    | 'coringLength'
    | 'cablePullingLength'
    | 'conduitLayingLength'
    | 'trialPitCount'
>

type MetricConfig = {
    key: MetricKey
    label: string
    unit: string
    color: string
}

const METRICS: MetricConfig[] = [
    { key: 'trenchLength', label: '累計開坑長度', unit: '米', color: '#16866f' },
    { key: 'coringLength', label: '累計Coring長度', unit: '米', color: '#2f7bd6' },
    { key: 'cablePullingLength', label: '累計拉線長度', unit: '米', color: '#c47a1a' },
    { key: 'conduitLayingLength', label: '累計放筒長度', unit: '米', color: '#7a5cc7' },
    { key: 'trialPitCount', label: '累計探窿數量', unit: '個', color: '#c24b5a' },
]

function formatAxisDate(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) return value
    return `${match[2]}/${match[3]}`
}

function formatTooltipValue(value: number, unit: string): string {
    const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1)
    return `${rounded} ${unit}`
}

function MetricChartCard({
    metric,
    points,
}: {
    metric: MetricConfig
    points: MetricsSeriesPoint[]
}) {
    const gradientId = useId().replace(/:/g, '')
    // Values are already cumulative running totals — only the latest reading is meaningful.
    const latest = points.at(-1)?.[metric.key] ?? 0

    return (
        <article className="report-metric-card">
            <header className="report-metric-card-head">
                <div>
                    <h3>{metric.label}</h3>
                    <p className="report-metric-card-unit">{metric.unit}</p>
                </div>
                <div className="report-metric-card-stats">
                    <span>
                        <strong>{formatTooltipValue(latest, metric.unit)}</strong>
                        <small>latest</small>
                    </span>
                </div>
            </header>
            <div className="report-metric-chart">
                {points.length === 0 ? (
                    <p className="report-metric-empty">No data in range</p>
                ) : (
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                            <defs>
                                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor={metric.color} stopOpacity={0.35} />
                                    <stop offset="100%" stopColor={metric.color} stopOpacity={0.02} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid stroke="rgba(45, 65, 60, 0.08)" vertical={false} />
                            <XAxis
                                dataKey="date"
                                tickFormatter={formatAxisDate}
                                tick={{ fill: '#6f857c', fontSize: 11 }}
                                axisLine={false}
                                tickLine={false}
                                minTickGap={28}
                            />
                            <YAxis
                                tick={{ fill: '#6f857c', fontSize: 11 }}
                                axisLine={false}
                                tickLine={false}
                                width={36}
                                allowDecimals={metric.key !== 'trialPitCount'}
                            />
                            <Tooltip
                                cursor={{ stroke: metric.color, strokeOpacity: 0.25 }}
                                contentStyle={{
                                    border: '1px solid #dce8e3',
                                    borderRadius: 12,
                                    background: '#fff',
                                    boxShadow: '0 10px 28px rgba(16, 36, 30, 0.12)',
                                    fontSize: 12,
                                }}
                                labelFormatter={(label) => String(label)}
                                formatter={(value) => [
                                    formatTooltipValue(Number(value ?? 0), metric.unit),
                                    metric.label,
                                ]}
                            />
                            <Area
                                type="monotone"
                                dataKey={metric.key}
                                stroke={metric.color}
                                strokeWidth={2.2}
                                fill={`url(#${gradientId})`}
                                dot={false}
                                activeDot={{ r: 4, strokeWidth: 0 }}
                                isAnimationActive={points.length < 90}
                            />
                        </AreaChart>
                    </ResponsiveContainer>
                )}
            </div>
        </article>
    )
}

export default function ReportMetricsCharts({
    from,
    to,
    groupJid,
    query,
    dateField,
    active,
    reloadKey,
}: {
    from: string
    to: string
    groupJid: string | null
    query: string
    dateField: DailySiteReportDateField
    active: boolean
    reloadKey: number
}) {
    const [points, setPoints] = useState<MetricsSeriesPoint[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!active) return undefined
        const controller = new AbortController()
        const params = new URLSearchParams({ from, to, dateField })
        if (groupJid) params.set('group', groupJid)
        if (query.trim()) params.set('q', query.trim())

        setLoading(true)
        setError(null)
        fetch(`/api/daily-site-reports/metrics-series?${params}`, {
            signal: controller.signal,
        })
            .then(async (response) => {
                const body = (await response.json()) as MetricsSeriesResponse & {
                    error?: string
                }
                if (!response.ok) {
                    throw new Error(body.error || `Request failed (${response.status})`)
                }
                setPoints(body.points)
            })
            .catch((reason: unknown) => {
                if ((reason as Error).name === 'AbortError') return
                setError(reason instanceof Error ? reason.message : 'Could not load charts')
                setPoints([])
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false)
            })

        return () => controller.abort()
    }, [active, from, to, groupJid, query, dateField, reloadKey])

    return (
        <section className="report-metrics" aria-label="Cumulative metrics charts">
            <div className="report-metrics-head">
                <div>
                    <h3>Cumulative metrics</h3>
                    <p>Latest cumulative values for the current filters</p>
                </div>
                {loading && <span className="report-metrics-loading">Updating…</span>}
            </div>
            {error && <p className="report-metrics-error">{error}</p>}
            <div className="report-metrics-grid">
                {METRICS.map((metric) => (
                    <MetricChartCard key={metric.key} metric={metric} points={points} />
                ))}
            </div>
        </section>
    )
}
