import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type Mode = 'day' | 'range'

type Props = {
    from: string
    to: string
    max: string
    onChange: (from: string, to: string) => void
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const monthTitle = new Intl.DateTimeFormat('en-HK', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
})

const longDate = new Intl.DateTimeFormat('en-HK', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
})

const shortDate = new Intl.DateTimeFormat('en-HK', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
})

function utcDate(iso: string): Date {
    const [year, month, day] = iso.split('-').map(Number)
    return new Date(Date.UTC(year, month - 1, day))
}

function toIso(date: Date): string {
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
    ].join('-')
}

function monthOf(iso: string): { year: number; month: number } {
    const date = utcDate(iso)
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }
}

function shiftMonth(view: { year: number; month: number }, delta: number) {
    const date = new Date(Date.UTC(view.year, view.month - 1 + delta, 1))
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }
}

function ordered(a: string, b: string): [string, string] {
    return a <= b ? [a, b] : [b, a]
}

function formatRangeLabel(from: string, to: string): string {
    const [start, end] = ordered(from, to)
    if (start === end) return longDate.format(utcDate(start))
    const a = utcDate(start)
    const b = utcDate(end)
    if (a.getUTCFullYear() === b.getUTCFullYear()) {
        if (a.getUTCMonth() === b.getUTCMonth()) {
            return `${a.getUTCDate()} – ${longDate.format(b)}`
        }
        return `${shortDate.format(a)} – ${longDate.format(b)}`
    }
    return `${longDate.format(a)} – ${longDate.format(b)}`
}

function monthCells(year: number, month: number): Array<string | null> {
    const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const cells: Array<string | null> = Array.from({ length: firstWeekday }, () => null)
    for (let day = 1; day <= days; day += 1) {
        cells.push(toIso(new Date(Date.UTC(year, month - 1, day))))
    }
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
}

function weeks(cells: Array<string | null>): Array<Array<string | null>> {
    const rows: Array<Array<string | null>> = []
    for (let index = 0; index < cells.length; index += 7) {
        rows.push(cells.slice(index, index + 7))
    }
    return rows
}

export default function DateRangePicker({ from, to, max, onChange }: Props) {
    const [open, setOpen] = useState(false)
    const [mode, setMode] = useState<Mode>(from === to ? 'day' : 'range')
    const [viewMonth, setViewMonth] = useState(() => monthOf(from))
    const [rangeAnchor, setRangeAnchor] = useState<string | null>(null)
    const [hoverDate, setHoverDate] = useState<string | null>(null)
    const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null)
    const rootRef = useRef<HTMLDivElement>(null)
    const popoverRef = useRef<HTMLDivElement>(null)

    const [start, end] = ordered(from, to)
    const isDay = start === end
    const preview = useMemo(() => {
        if (mode === 'range' && rangeAnchor) {
            return ordered(rangeAnchor, hoverDate && hoverDate <= max ? hoverDate : rangeAnchor)
        }
        return [start, end] as [string, string]
    }, [end, hoverDate, max, mode, rangeAnchor, start])

    useEffect(() => {
        if (open) return
        setMode(from === to ? 'day' : 'range')
        setRangeAnchor(null)
        setHoverDate(null)
    }, [from, to, open])

    useEffect(() => {
        if (!open) return undefined
        function onPointerDown(event: PointerEvent) {
            const target = event.target as Node
            if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return
            setOpen(false)
        }
        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        window.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    useLayoutEffect(() => {
        if (!open) {
            setMenuPos(null)
            return undefined
        }
        function update() {
            const rect = rootRef.current?.getBoundingClientRect()
            if (!rect) return
            const width = Math.min(352, window.innerWidth - 16)
            let left = rect.left
            if (left + width > window.innerWidth - 8) {
                left = Math.max(8, window.innerWidth - 8 - width)
            }
            const gap = 6
            let top = rect.bottom + gap
            const height = popoverRef.current?.offsetHeight ?? 380
            if (top + height > window.innerHeight - 8) {
                const above = rect.top - height - gap
                top = above >= 8 ? above : Math.max(8, window.innerHeight - 8 - height)
            }
            setMenuPos({ top, left, width })
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
        }
    }, [open, mode, viewMonth, rangeAnchor])

    function openPicker() {
        setMode(from === to ? 'day' : 'range')
        setRangeAnchor(null)
        setHoverDate(null)
        setViewMonth(monthOf(from <= to ? from : to))
        setOpen(true)
    }

    function chooseMode(next: Mode) {
        setMode(next)
        setHoverDate(null)
        setRangeAnchor(null)
    }

    function selectDay(iso: string) {
        if (iso > max) return
        if (mode === 'day') {
            onChange(iso, iso)
            setOpen(false)
            return
        }
        if (!rangeAnchor) {
            setRangeAnchor(iso)
            setHoverDate(iso)
            return
        }
        const [nextFrom, nextTo] = ordered(rangeAnchor, iso)
        onChange(nextFrom, nextTo)
        setRangeAnchor(null)
        setHoverDate(null)
        setOpen(false)
    }

    const maxMonth = monthOf(max)
    const canGoNext =
        viewMonth.year < maxMonth.year ||
        (viewMonth.year === maxMonth.year && viewMonth.month < maxMonth.month)
    const hint =
        mode === 'day'
            ? 'Pick a day'
            : rangeAnchor
              ? 'Pick the end date'
              : 'Pick the start date'
    const cells = monthCells(viewMonth.year, viewMonth.month)
    const viewDate = new Date(Date.UTC(viewMonth.year, viewMonth.month - 1, 1))
    const [previewStart, previewEnd] = preview

    return (
        <div className="date-picker" ref={rootRef}>
            <button
                type="button"
                className="date-picker-toggle"
                aria-expanded={open}
                aria-haspopup="dialog"
                aria-label={`Date filter, ${isDay ? 'one day' : 'range'}, ${formatRangeLabel(start, end)}`}
                onClick={() => (open ? setOpen(false) : openPicker())}
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="16" rx="2" />
                    <path d="M16 3v4M8 3v4M3 10h18" />
                </svg>
                <span className="date-picker-copy">
                    <span>{isDay ? 'Day' : 'Range'}</span>
                    <strong>{formatRangeLabel(start, end)}</strong>
                </span>
                <svg className="date-picker-chevron" viewBox="0 0 24 24" aria-hidden="true">
                    <path d={open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
                </svg>
            </button>
            {open &&
                createPortal(
                    <div
                        className="date-picker-popover"
                        ref={popoverRef}
                        role="dialog"
                        aria-label="Choose a day or date range"
                        style={{
                            top: menuPos?.top ?? 0,
                            left: menuPos?.left ?? 0,
                            width: menuPos?.width ?? 352,
                            visibility: menuPos ? 'visible' : 'hidden',
                        }}
                    >
                        <div className="segmented-control date-picker-modes">
                            <button
                                type="button"
                                className={mode === 'day' ? 'active' : ''}
                                aria-pressed={mode === 'day'}
                                onClick={() => chooseMode('day')}
                            >
                                Day
                            </button>
                            <button
                                type="button"
                                className={mode === 'range' ? 'active' : ''}
                                aria-pressed={mode === 'range'}
                                onClick={() => chooseMode('range')}
                            >
                                Range
                            </button>
                        </div>
                        <p className="date-picker-hint">{hint}</p>
                        <div className="date-cal-header">
                            <button
                                type="button"
                                className="date-cal-nav"
                                aria-label="Previous month"
                                onClick={() => setViewMonth((current) => shiftMonth(current, -1))}
                            >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="m15 6-6 6 6 6" />
                                </svg>
                            </button>
                            <p>{monthTitle.format(viewDate)}</p>
                            <button
                                type="button"
                                className="date-cal-nav"
                                aria-label="Next month"
                                disabled={!canGoNext}
                                onClick={() => setViewMonth((current) => shiftMonth(current, 1))}
                            >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="m9 6 6 6-6 6" />
                                </svg>
                            </button>
                        </div>
                        <div
                            className="date-cal"
                            onPointerLeave={() => setHoverDate(null)}
                        >
                            <div className="date-cal-weekdays">
                                {WEEKDAYS.map((day) => (
                                    <span key={day}>{day}</span>
                                ))}
                            </div>
                            {weeks(cells).map((row) => (
                                <div className="date-cal-row" key={row.join('-')}>
                                    {row.map((iso, index) => {
                                        if (!iso) {
                                            return <span className="date-cal-empty" key={`e${index}`} />
                                        }
                                        const disabled = iso > max
                                        const selected = iso >= previewStart && iso <= previewEnd
                                        const isStart = iso === previewStart
                                        const isEnd = iso === previewEnd
                                        const isToday = iso === max
                                        return (
                                            <button
                                                key={iso}
                                                type="button"
                                                className={[
                                                    'date-cal-day',
                                                    selected ? 'is-selected' : '',
                                                    isStart ? 'is-start' : '',
                                                    isEnd ? 'is-end' : '',
                                                    isToday ? 'is-today' : '',
                                                ]
                                                    .filter(Boolean)
                                                    .join(' ')}
                                                disabled={disabled}
                                                aria-pressed={selected}
                                                aria-current={isToday ? 'date' : undefined}
                                                aria-label={longDate.format(utcDate(iso))}
                                                onPointerEnter={() => {
                                                    if (mode === 'range' && rangeAnchor && !disabled) {
                                                        setHoverDate(iso)
                                                    }
                                                }}
                                                onClick={() => selectDay(iso)}
                                            >
                                                {Number(iso.slice(-2))}
                                            </button>
                                        )
                                    })}
                                </div>
                            ))}
                        </div>
                    </div>,
                    document.body
                )}
        </div>
    )
}
