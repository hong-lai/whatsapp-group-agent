import { useEffect, useRef, type TouchEvent } from 'react'
import { createPortal } from 'react-dom'
import DateRangePicker from './DateRangePicker'
import {
    allMediaCategories,
    categoryOptions,
    isAllTypes,
    ToolbarIcon,
    type MediaCategory,
} from './AlbumView'
import type { AlbumScope } from './AlbumView'
import type { SortOrder } from './useVisibleInterval'

type Props = {
    open: boolean
    onClose: () => void
    from: string
    to: string
    today: string
    onRangeChange: (from: string, to: string) => void
    onPreset: (days: number) => void
    sortOrder: SortOrder
    onSortChange: (order: SortOrder) => void
    view: 'messages' | 'album'
    types: MediaCategory[]
    onTypesChange: (types: MediaCategory[]) => void
    counts: Record<MediaCategory, number>
    scope: AlbumScope
    selectedGroupNames: string[]
    onOpenGroups: () => void
}

const presets = [
    { days: 1, long: 'Today', short: '1d' },
    { days: 2, long: '2 days', short: '2d' },
    { days: 7, long: '7 days', short: '7d' },
    { days: 30, long: '30 days', short: '30d' },
] as const

function addDays(date: string, days: number): string {
    const [year, month, day] = date.split('-').map(Number)
    const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86400000)
    return [
        shifted.getUTCFullYear(),
        String(shifted.getUTCMonth() + 1).padStart(2, '0'),
        String(shifted.getUTCDate()).padStart(2, '0'),
    ].join('-')
}

export default function FilterSheet({
    open,
    onClose,
    from,
    to,
    today,
    onRangeChange,
    onPreset,
    sortOrder,
    onSortChange,
    view,
    types,
    onTypesChange,
    counts,
    scope,
    selectedGroupNames,
    onOpenGroups,
}: Props) {
    const panelRef = useRef<HTMLElement>(null)
    const closeRef = useRef<HTMLButtonElement>(null)
    const startY = useRef<number | null>(null)
    const showingAll = isAllTypes(types)
    const totalCount = Object.values(counts).reduce((sum, count) => sum + count, 0)

    useEffect(() => {
        if (!open) return undefined
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        closeRef.current?.focus()

        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => {
            document.body.style.overflow = previous
            window.removeEventListener('keydown', onKey)
        }
    }, [open, onClose])

    function onHandleStart(event: TouchEvent) {
        startY.current = event.touches[0]?.clientY ?? null
    }

    function onHandleMove(event: TouchEvent) {
        if (startY.current == null || !panelRef.current) return
        const delta = event.touches[0].clientY - startY.current
        panelRef.current.style.transform = `translateY(${Math.max(0, delta)}px)`
    }

    function onHandleEnd(event: TouchEvent) {
        if (startY.current == null || !panelRef.current) return
        const delta = event.changedTouches[0].clientY - startY.current
        panelRef.current.style.transform = ''
        startY.current = null
        if (delta > 64) onClose()
    }

    function toggleType(category: MediaCategory) {
        if (showingAll) {
            onTypesChange([category])
            return
        }
        if (types.includes(category)) {
            const next = types.filter((item) => item !== category)
            onTypesChange(next.length === 0 ? [...allMediaCategories] : next)
            return
        }
        onTypesChange([...types, category])
    }

    if (!open) return null

    return createPortal(
        <div className="sheet-overlay" role="presentation" onClick={onClose}>
            <section
                ref={panelRef}
                className="filter-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="filter-sheet-title"
                onClick={(event) => event.stopPropagation()}
            >
                <div
                    className="sheet-handle"
                    onTouchStart={onHandleStart}
                    onTouchMove={onHandleMove}
                    onTouchEnd={onHandleEnd}
                >
                    <span />
                </div>
                <header className="sheet-header">
                    <h2 id="filter-sheet-title">Filters</h2>
                    <button
                        ref={closeRef}
                        type="button"
                        className="sheet-close"
                        aria-label="Close"
                        onClick={onClose}
                    >
                        ×
                    </button>
                </header>
                <div className="sheet-body">
                    <section className="sheet-section">
                        <h3>When</h3>
                        <div className="sheet-when">
                            <DateRangePicker from={from} to={to} max={today} onChange={onRangeChange} />
                            <div className="presets sheet-presets" aria-label="Date presets">
                                {presets.map((preset) => (
                                    <button
                                        key={preset.days}
                                        type="button"
                                        className={
                                            from === addDays(today, -(preset.days - 1)) && to === today
                                                ? 'active'
                                                : ''
                                        }
                                        onClick={() => onPreset(preset.days)}
                                    >
                                        <span className="preset-long">{preset.long}</span>
                                        <span className="preset-short">{preset.short}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </section>

                    <section className="sheet-section">
                        <h3>Sort</h3>
                        <div className="segmented-control sheet-sort" role="group" aria-label="Sort order">
                            <button
                                type="button"
                                className={sortOrder === 'desc' ? 'active' : ''}
                                aria-pressed={sortOrder === 'desc'}
                                onClick={() => onSortChange('desc')}
                            >
                                Newest first
                            </button>
                            <button
                                type="button"
                                className={sortOrder === 'asc' ? 'active' : ''}
                                aria-pressed={sortOrder === 'asc'}
                                onClick={() => onSortChange('asc')}
                            >
                                Oldest first
                            </button>
                        </div>
                    </section>

                    {view === 'album' && (
                        <>
                            <section className="sheet-section">
                                <h3>Media types</h3>
                                <div className="media-filters sheet-types" aria-label="Media type filters">
                                    <button
                                        type="button"
                                        className={showingAll ? 'active' : ''}
                                        onClick={() => {
                                            if (!showingAll) onTypesChange([...allMediaCategories])
                                        }}
                                        aria-pressed={showingAll}
                                        aria-label={`All types, ${totalCount}`}
                                    >
                                        <span className="filter-icon">
                                            <ToolbarIcon name="all" />
                                        </span>
                                        <span className="type-name">All</span>
                                        <strong>{totalCount}</strong>
                                    </button>
                                    {categoryOptions.map((category) => (
                                        <button
                                            key={category.id}
                                            type="button"
                                            className={
                                                !showingAll && types.includes(category.id) ? 'active' : ''
                                            }
                                            onClick={() => toggleType(category.id)}
                                            aria-pressed={!showingAll && types.includes(category.id)}
                                            aria-label={`${category.label}, ${counts[category.id]}`}
                                        >
                                            <span className="filter-icon">
                                                <ToolbarIcon name={category.icon} />
                                            </span>
                                            <span className="type-name">
                                                {category.id === 'document' ? 'Docs' : category.label.replace(/s$/, '')}
                                            </span>
                                            <strong>{counts[category.id]}</strong>
                                        </button>
                                    ))}
                                </div>
                            </section>

                            <section className="sheet-section">
                                <h3>Groups</h3>
                                <button
                                    type="button"
                                    className="sheet-groups-link"
                                    onClick={onOpenGroups}
                                >
                                    {scope === 'group' && selectedGroupNames.length
                                        ? selectedGroupNames.join(' · ')
                                        : 'Filter by group'}
                                </button>
                            </section>
                        </>
                    )}
                </div>
            </section>
        </div>,
        document.body
    )
}
