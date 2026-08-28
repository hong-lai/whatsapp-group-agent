import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { mergeFirstPage, useInfiniteScroll, useVisibleInterval } from './useVisibleInterval'

export type MediaCategory = 'image' | 'video' | 'document' | 'audio' | 'sticker'
export type AlbumScope = 'all' | 'group'

type GroupOption = {
    jid: string
    name: string
}

type AlbumItem = {
    messageId: string
    groupJid: string
    groupName: string
    senderName: string | null
    messageType: string
    textContent: string | null
    timestamp: number
    category: MediaCategory
    mediaUrl: string
    fileName: string | null
}

type AlbumResponse = {
    items: AlbumItem[]
    counts: Record<MediaCategory, number>
    nextCursor: string | null
    error?: string
}

type Props = {
    from: string
    to: string
    groups: GroupOption[]
    selectedJid: string | null
    selectedJids: string[]
    onSelectedJidsChange: (jids: string[]) => void
    scope: AlbumScope
    onScopeChange: (scope: AlbumScope) => void
    types: MediaCategory[]
    onTypesChange: (types: MediaCategory[]) => void
    active: boolean
    onLiveUpdate: () => void
}

export const allMediaCategories: MediaCategory[] = ['image', 'video', 'document', 'audio', 'sticker']

const categoryOptions: Array<{
    id: MediaCategory
    label: string
    icon: 'image' | 'video' | 'document' | 'audio' | 'sticker'
}> = [
    { id: 'image', label: 'Images', icon: 'image' },
    { id: 'video', label: 'Videos', icon: 'video' },
    { id: 'document', label: 'PDFs / Docs', icon: 'document' },
    { id: 'audio', label: 'Audio', icon: 'audio' },
    { id: 'sticker', label: 'Stickers', icon: 'sticker' },
]

const emptyCounts: Record<MediaCategory, number> = {
    image: 0,
    video: 0,
    document: 0,
    audio: 0,
    sticker: 0,
}

const hkDateTime = new Intl.DateTimeFormat('en-HK', {
    timeZone: 'Asia/Hong_Kong',
    dateStyle: 'medium',
    timeStyle: 'medium',
})

function albumUrl(
    from: string,
    to: string,
    scope: AlbumScope,
    selectedJids: string[],
    types: MediaCategory[],
    cursor?: string
): string {
    const params = new URLSearchParams({ from, to, types: types.join(',') })
    if (scope === 'group') {
        params.set('groups', selectedJids.join(','))
        if (selectedJids.length === 1) params.set('group', selectedJids[0])
    }
    if (cursor) params.set('cursor', cursor)
    return `/api/album?${params}`
}

function isAllTypes(types: MediaCategory[]): boolean {
    return types.length === allMediaCategories.length
}

async function albumJson(url: string, signal?: AbortSignal): Promise<AlbumResponse> {
    const response = await fetch(url, { signal })
    const body = (await response.json()) as AlbumResponse
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
    return body
}

function stopTileAction(event: MouseEvent) {
    event.stopPropagation()
}

function fileExtensionLabel(fileName: string | null | undefined, fallback = 'FILE'): string {
    if (!fileName) return fallback
    const dot = fileName.lastIndexOf('.')
    const ext = dot >= 0 ? fileName.slice(dot + 1) : ''
    return (ext || fallback).slice(0, 5).toUpperCase()
}

function isPdfFile(item: AlbumItem): boolean {
    return fileExtensionLabel(item.fileName, '').toLowerCase() === 'pdf'
}

function stepAlbumItem(currentId: string, items: AlbumItem[], delta: number): string {
    const index = items.findIndex((item) => item.messageId === currentId)
    if (index < 0 || items.length === 0) return currentId
    return items[(index + delta + items.length) % items.length].messageId
}

function groupAlbumItems(
    items: AlbumItem[]
): Array<{ jid: string; name: string; items: AlbumItem[] }> {
    const order: string[] = []
    const byJid = new Map<string, AlbumItem[]>()
    for (const item of items) {
        const existing = byJid.get(item.groupJid)
        if (!existing) {
            order.push(item.groupJid)
            byJid.set(item.groupJid, [item])
        } else {
            existing.push(item)
        }
    }
    return order.map((jid) => {
        const grouped = byJid.get(jid) ?? []
        return { jid, name: grouped[0]?.groupName || jid, items: grouped }
    })
}

function GroupPicker({
    groups,
    selectedJids,
    onChange,
}: {
    groups: GroupOption[]
    selectedJids: string[]
    onChange: (jids: string[]) => void
}) {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const selected = groups.filter((group) => selectedJids.includes(group.jid))
    const label =
        selected.length === 0
            ? 'Select groups'
            : selected.length === 1
              ? selected[0].name
              : `${selected[0].name} +${selected.length - 1}`

    useEffect(() => {
        if (!open) return undefined
        function onPointerDown(event: PointerEvent) {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        return () => document.removeEventListener('pointerdown', onPointerDown)
    }, [open])

    function toggle(jid: string) {
        onChange(
            selectedJids.includes(jid)
                ? selectedJids.filter((item) => item !== jid)
                : [...selectedJids, jid]
        )
    }

    return (
        <div className="group-picker" ref={rootRef}>
            <button
                type="button"
                className="group-picker-toggle"
                aria-expanded={open}
                aria-haspopup="listbox"
                aria-label="Selected groups"
                title={selected.map((group) => group.name).join(', ') || 'Select groups'}
                onClick={() => setOpen((current) => !current)}
            >
                <span>{label}</span>
                <svg className="picker-chevron" viewBox="0 0 24 24" aria-hidden="true">
                    <path d={open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
                </svg>
            </button>
            {open && (
                <div className="group-picker-menu" role="listbox" aria-multiselectable="true">
                    {groups.map((group) => {
                        const checked = selectedJids.includes(group.jid)
                        return (
                            <label
                                className={checked ? 'is-selected' : ''}
                                key={group.jid}
                            >
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggle(group.jid)}
                                />
                                <span>{group.name}</span>
                            </label>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

function ToolbarIcon({
    name,
}: {
    name:
        | 'groups'
        | 'group'
        | 'selectAll'
        | 'clear'
        | 'all'
        | 'image'
        | 'video'
        | 'document'
        | 'audio'
        | 'sticker'
}) {
    const paths = {
        groups: (
            <>
                <circle cx="9" cy="8" r="3" />
                <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5v1" />
            </>
        ),
        group: (
            <>
                <path d="M4 5h16l-5.8 7.4V19l-4.4 2v-8.6L4 5z" />
            </>
        ),
        selectAll: (
            <>
                <rect x="4" y="4" width="16" height="16" rx="3" />
                <path d="m8 12 2.5 2.5L16 9" />
            </>
        ),
        clear: <path d="M7 7l10 10M17 7 7 17" />,
        all: (
            <>
                <rect x="4" y="4" width="7" height="7" rx="1.5" />
                <rect x="13" y="4" width="7" height="7" rx="1.5" />
                <rect x="4" y="13" width="7" height="7" rx="1.5" />
                <rect x="13" y="13" width="7" height="7" rx="1.5" />
            </>
        ),
        image: (
            <>
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <circle cx="8.5" cy="10" r="1.5" />
                <path d="m21 16-5.5-5.5-4 4L9 12l-6 6" />
            </>
        ),
        video: (
            <>
                <rect x="3" y="6" width="14" height="12" rx="2" />
                <path d="m17 10 4-2v8l-4-2z" />
            </>
        ),
        document: (
            <>
                <path d="M7 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V5A1.5 1.5 0 0 1 7 3.5z" />
                <path d="M14 3.5V9h5.5M8.5 13h7M8.5 16.5h5" />
            </>
        ),
        audio: (
            <>
                <path d="M11 5 6 9H2v6h4l5 4z" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </>
        ),
        sticker: (
            <>
                <path d="M5 8.5A3.5 3.5 0 0 1 8.5 5h7A3.5 3.5 0 0 1 19 8.5v7A3.5 3.5 0 0 1 15.5 19h-7A3.5 3.5 0 0 1 5 15.5z" />
                <path d="M9 10.2h.01M15 10.2h.01M9.5 14.5s1.3 1.8 2.5 1.8 2.5-1.8 2.5-1.8" />
            </>
        ),
    }

    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            {paths[name]}
        </svg>
    )
}

function DownloadIcon() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4v12" />
            <path d="m7 11 5 5 5-5" />
            <path d="M5 20h14" />
        </svg>
    )
}

function LightboxPreview({ item }: { item: AlbumItem }) {
    if (item.category === 'video') {
        return (
            <video
                key={item.messageId}
                src={item.mediaUrl}
                controls
                playsInline
                preload="auto"
            />
        )
    }
    if (item.category === 'image' || item.category === 'sticker') {
        return (
            <img
                key={item.messageId}
                src={item.mediaUrl}
                alt={item.textContent || item.category}
            />
        )
    }
    if (item.category === 'audio') {
        return (
            <div className="lightbox-file audio">
                <span className="file-glyph">♪</span>
                <strong>{item.fileName || 'Audio message'}</strong>
                <audio key={item.messageId} src={item.mediaUrl} controls preload="auto" />
            </div>
        )
    }
    if (isPdfFile(item)) {
        return (
            <iframe
                key={item.messageId}
                className="lightbox-pdf"
                title={item.fileName || 'PDF document'}
                src={item.mediaUrl}
            />
        )
    }
    return (
        <div className="lightbox-file">
            <span className="file-glyph">{fileExtensionLabel(item.fileName)}</span>
            <strong>{item.fileName || 'Shared document'}</strong>
            <p>This file can't be previewed here.</p>
            <a
                href={item.mediaUrl}
                target="_blank"
                rel="noreferrer"
                download={item.fileName || undefined}
                className="download-button"
            >
                <DownloadIcon />
                Download
            </a>
        </div>
    )
}

function MediaTile({
    item,
    selected,
    onToggle,
    onOpen,
}: {
    item: AlbumItem
    selected: boolean
    onToggle: () => void
    onOpen: () => void
}) {
    const visual = item.category === 'image' || item.category === 'sticker' || item.category === 'video'

    return (
        <article className={`album-tile ${selected ? 'selected' : ''}`}>
            <button
                type="button"
                className="tile-select"
                aria-label={`${selected ? 'Deselect' : 'Select'} ${item.category} from ${item.groupName}`}
                aria-pressed={selected}
                onClick={onToggle}
            >
                {selected ? '✓' : ''}
            </button>
            {visual ? (
                <button
                    type="button"
                    className="album-preview"
                    onClick={onOpen}
                    aria-label={`View ${item.category} from ${item.groupName}`}
                >
                    {item.category === 'video' ? (
                        <>
                            <video src={`${item.mediaUrl}#t=0.001`} muted playsInline preload="metadata" />
                            <span className="video-mark">▶</span>
                        </>
                    ) : (
                        <img src={item.mediaUrl} alt={item.textContent || item.category} loading="lazy" />
                    )}
                </button>
            ) : (
                <div className={`album-file-card ${item.category}`}>
                    <button
                        type="button"
                        className="album-file-open"
                        onClick={onOpen}
                        aria-label={`View ${item.category} from ${item.groupName}`}
                    >
                        <span className="file-glyph">
                            {item.category === 'audio'
                                ? '♪'
                                : fileExtensionLabel(item.fileName, 'FILE')}
                        </span>
                        <span className="file-name">
                            {item.fileName ||
                                (item.category === 'audio' ? 'Audio message' : 'Shared document')}
                        </span>
                    </button>
                    {item.category === 'audio' && (
                        <audio src={item.mediaUrl} controls preload="none" />
                    )}
                    {item.category === 'document' && (
                        <a
                            href={item.mediaUrl}
                            target="_blank"
                            rel="noreferrer"
                            download={item.fileName || undefined}
                        >
                            Download ↗
                        </a>
                    )}
                </div>
            )}
            <div className="album-tile-meta">
                <time>{hkDateTime.format(item.timestamp * 1000)}</time>
            </div>
        </article>
    )
}

export default function AlbumView({
    from,
    to,
    groups,
    selectedJid,
    selectedJids,
    onSelectedJidsChange,
    scope,
    onScopeChange,
    types,
    onTypesChange,
    active,
    onLiveUpdate,
}: Props) {
    const [items, setItems] = useState<AlbumItem[]>([])
    const [counts, setCounts] = useState<Record<MediaCategory, number>>(emptyCounts)
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [lightboxId, setLightboxId] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [downloading, setDownloading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const requestId = useRef(0)
    const silentGen = useRef(0)
    const silentBusy = useRef(false)
    const scrollRef = useRef<HTMLDivElement>(null)
    const scrollRestore = useRef<{ top: number; height: number } | null>(null)
    const nextCursorRef = useRef<string | null>(null)
    nextCursorRef.current = nextCursor
    const showingAll = isAllTypes(types)
    const totalCount = Object.values(counts).reduce((sum, count) => sum + count, 0)

    const scopedJids = scope === 'group' ? selectedJids : []
    const filterKey = `${from}|${to}|${scope}|${scopedJids.join(',')}|${types.join(',')}`

    useEffect(() => {
        return () => {
            silentGen.current += 1
        }
    }, [])

    useLayoutEffect(() => {
        const pending = scrollRestore.current
        const list = scrollRef.current
        if (!pending || !list) return
        list.scrollTop = pending.top + (list.scrollHeight - pending.height)
        scrollRestore.current = null
    }, [items])

    useEffect(() => {
        silentGen.current += 1
        setSelected(new Set())
        setLightboxId(null)
        const controller = new AbortController()
        const currentRequest = ++requestId.current
        scrollRestore.current = null
        setLoading(true)
        setError(null)
        albumJson(albumUrl(from, to, scope, selectedJids, types), controller.signal)
            .then((data) => {
                if (currentRequest !== requestId.current) return
                setItems(data.items)
                setCounts(data.counts)
                setNextCursor(data.nextCursor)
            })
            .catch((reason: unknown) => {
                if (currentRequest === requestId.current && (reason as Error).name !== 'AbortError') {
                    setError(reason instanceof Error ? reason.message : 'Could not load media')
                }
            })
            .finally(() => {
                if (currentRequest === requestId.current) setLoading(false)
            })
        return () => controller.abort()
    }, [filterKey, from, to, scope, selectedJids, types])

    async function silentRefresh() {
        if (!active || loading || loadingMore || downloading || silentBusy.current) return
        const gen = ++silentGen.current
        silentBusy.current = true
        try {
            const data = await albumJson(albumUrl(from, to, scope, selectedJids, types))
            if (gen !== silentGen.current) return
            const list = scrollRef.current
            if (list && list.scrollTop > 40) {
                scrollRestore.current = { top: list.scrollTop, height: list.scrollHeight }
            } else {
                scrollRestore.current = null
            }
            setItems((current) => {
                const merged = mergeFirstPage(current, data.items)
                nextCursorRef.current = merged.keptTail ? nextCursorRef.current : data.nextCursor
                return merged.items
            })
            setNextCursor(nextCursorRef.current)
            setCounts(data.counts)
            setError(null)
            onLiveUpdate()
        } catch (reason: unknown) {
            if ((reason as Error).name === 'AbortError') return
        } finally {
            silentBusy.current = false
        }
    }

    useVisibleInterval(silentRefresh, active ? 10_000 : null)

    const albumSentinelRef = useInfiniteScroll(
        scrollRef,
        () => {
            void loadMore()
        },
        active && Boolean(nextCursor) && !loadingMore && !loading
    )

    const selectedItems = useMemo(
        () => items.filter((item) => selected.has(item.messageId)),
        [items, selected]
    )
    const groupedItems = useMemo(() => groupAlbumItems(items), [items])
    const displayItems = useMemo(
        () => groupedItems.flatMap((group) => group.items),
        [groupedItems]
    )
    const lightboxIndex = lightboxId
        ? displayItems.findIndex((item) => item.messageId === lightboxId)
        : -1
    const lightbox = lightboxIndex >= 0 ? displayItems[lightboxIndex] : null

    useEffect(() => {
        if (!lightboxId) return undefined
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') setLightboxId(null)
            if (displayItems.length < 2) return
            if (event.key === 'ArrowRight') {
                setLightboxId((current) =>
                    current ? stepAlbumItem(current, displayItems, 1) : current
                )
            }
            if (event.key === 'ArrowLeft') {
                setLightboxId((current) =>
                    current ? stepAlbumItem(current, displayItems, -1) : current
                )
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [lightboxId, displayItems])

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

    function toggleSelected(messageId: string) {
        setSelected((current) => {
            const next = new Set(current)
            if (next.has(messageId)) next.delete(messageId)
            else next.add(messageId)
            return next
        })
    }

    async function loadMore() {
        if (!nextCursor || loadingMore) return
        silentGen.current += 1
        setLoadingMore(true)
        setError(null)
        try {
            const data = await albumJson(
                albumUrl(from, to, scope, selectedJids, types, nextCursor)
            )
            setItems((current) => [...current, ...data.items])
            setNextCursor(data.nextCursor)
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not load more media')
        } finally {
            setLoadingMore(false)
        }
    }

    async function downloadZip() {
        if (selected.size === 0 || downloading) return
        silentGen.current += 1
        setDownloading(true)
        setError(null)
        try {
            const params = new URLSearchParams({ from, to, types: types.join(',') })
            if (scope === 'group') {
                params.set('groups', selectedJids.join(','))
                if (selectedJids.length === 1) params.set('group', selectedJids[0])
            }
            const response = await fetch(`/api/album/download?${params}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messageIds: [...selected] }),
            })
            if (!response.ok) {
                const body = (await response.json()) as { error?: string }
                throw new Error(body.error || 'Could not prepare download')
            }
            const blob = await response.blob()
            const disposition = response.headers.get('Content-Disposition') || ''
            const filename =
                /filename="([^"]+)"/.exec(disposition)?.[1] ||
                `whatsapp-media_${from}_to_${to}.zip`
            const objectUrl = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = objectUrl
            anchor.download = filename
            document.body.appendChild(anchor)
            anchor.click()
            anchor.remove()
            URL.revokeObjectURL(objectUrl)
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not download media')
        } finally {
            setDownloading(false)
        }
    }

    function selectAllVisible() {
        setSelected(new Set(items.map((item) => item.messageId)))
    }

    const allVisibleSelected =
        items.length > 0 && items.every((item) => selected.has(item.messageId))
    const showOverlay = loading && items.length > 0

    return (
        <section className="album-panel" aria-busy={loading}>
            <header className="album-toolbar">
                <div className="album-scope">
                    <div className="segmented-control" role="group" aria-label="Album scope">
                        <button
                            type="button"
                            className={scope === 'all' ? 'active' : ''}
                            onClick={() => onScopeChange('all')}
                            aria-label="All groups"
                            title="All groups"
                        >
                            <ToolbarIcon name="groups" />
                        </button>
                        <button
                            type="button"
                            className={scope === 'group' ? 'active' : ''}
                            onClick={() => {
                                onScopeChange('group')
                                if (selectedJids.length === 0 && selectedJid) {
                                    onSelectedJidsChange([selectedJid])
                                }
                            }}
                            aria-label="Selected groups"
                            title="Selected groups"
                        >
                            <ToolbarIcon name="group" />
                        </button>
                    </div>
                    {scope === 'group' && (
                        <GroupPicker
                            groups={groups}
                            selectedJids={selectedJids}
                            onChange={onSelectedJidsChange}
                        />
                    )}
                </div>
                <div className="media-filters" aria-label="Media type filters">
                    <button
                        className={showingAll ? 'active' : ''}
                        onClick={() => {
                            if (!showingAll) onTypesChange([...allMediaCategories])
                        }}
                        aria-pressed={showingAll}
                        aria-label={`All types, ${totalCount}`}
                        title="All types"
                    >
                        <span className="filter-icon"><ToolbarIcon name="all" /></span>
                        <strong>{totalCount}</strong>
                    </button>
                    {categoryOptions
                        .filter((category) => counts[category.id] > 0)
                        .map((category) => (
                            <button
                                key={category.id}
                                className={!showingAll && types.includes(category.id) ? 'active' : ''}
                                onClick={() => toggleType(category.id)}
                                aria-pressed={!showingAll && types.includes(category.id)}
                                aria-label={`${category.label}, ${counts[category.id]}`}
                                title={category.label}
                            >
                                <span className="filter-icon"><ToolbarIcon name={category.icon} /></span>
                                <strong>{counts[category.id]}</strong>
                            </button>
                        ))}
                </div>
                <div className="album-actions">
                    <div className="segmented-control" role="group" aria-label="Selection">
                        <button
                            type="button"
                            onClick={selectAllVisible}
                            disabled={items.length === 0 || allVisibleSelected}
                            aria-label={allVisibleSelected ? 'All selected' : 'Select all'}
                            title={allVisibleSelected ? 'All selected' : 'Select all'}
                        >
                            <ToolbarIcon name="selectAll" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setSelected(new Set())}
                            disabled={selected.size === 0}
                            aria-label="Clear selection"
                            title="Clear"
                        >
                            <ToolbarIcon name="clear" />
                        </button>
                    </div>
                </div>
            </header>

            {error && <div className="album-error" role="alert">{error}</div>}

            <div className={`album-scroll ${showOverlay ? 'is-loading' : ''}`} ref={scrollRef}>
                {showOverlay && (
                    <div className="content-overlay" role="status">
                        <span className="overlay-spinner" />
                        Updating
                    </div>
                )}
                {loading && items.length === 0 ? (
                    <div className="album-grid">
                        {[1, 2, 3, 4, 5, 6].map((item) => (
                            <div className="album-tile album-skeleton skeleton" key={item} />
                        ))}
                    </div>
                ) : items.length ? (
                    <>
                        {groupedItems.map((group) => (
                            <section className="album-group" key={group.jid}>
                                {!(scope === 'group' && selectedJids.length === 1) && (
                                    <h3 className="album-group-title">{group.name}</h3>
                                )}
                                <div className="album-grid">
                                    {group.items.map((item) => (
                                        <MediaTile
                                            item={item}
                                            selected={selected.has(item.messageId)}
                                            onToggle={() => toggleSelected(item.messageId)}
                                            onOpen={() => setLightboxId(item.messageId)}
                                            key={item.messageId}
                                        />
                                    ))}
                                </div>
                            </section>
                        ))}
                        {nextCursor && (
                            <div className="load-sentinel" ref={albumSentinelRef}>
                                {loadingMore ? 'Loading…' : ''}
                            </div>
                        )}
                    </>
                ) : (
                    <div className="album-empty">
                        <span>▧</span>
                        <h3>No media found</h3>
                        <p>Try another date range, group, or media type.</p>
                    </div>
                )}
            </div>

            {selected.size > 0 && (
                <div className="selection-bar">
                    <div>
                        <strong>{selected.size}</strong>
                        <span>selected</span>
                        {selectedItems.length < selected.size && (
                            <small>across loaded pages</small>
                        )}
                    </div>
                    <button className="download-button" onClick={downloadZip} disabled={downloading}>
                        <DownloadIcon />
                        {downloading ? 'Preparing ZIP…' : 'Download ZIP'}
                    </button>
                </div>
            )}

            {lightbox &&
                createPortal(
                <div
                    className="lightbox"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Media preview"
                    onClick={() => setLightboxId(null)}
                >
                    <button
                        className="lightbox-close"
                        onClick={(event) => {
                            event.stopPropagation()
                            setLightboxId(null)
                        }}
                        aria-label="Close"
                        type="button"
                    >
                        ×
                    </button>
                    {displayItems.length > 1 && (
                        <>
                            <button
                                className="lightbox-nav prev"
                                type="button"
                                aria-label="Previous"
                                onClick={(event) => {
                                    event.stopPropagation()
                                    setLightboxId(stepAlbumItem(lightbox.messageId, displayItems, -1))
                                }}
                            >
                                ‹
                            </button>
                            <button
                                className="lightbox-nav next"
                                type="button"
                                aria-label="Next"
                                onClick={(event) => {
                                    event.stopPropagation()
                                    setLightboxId(stepAlbumItem(lightbox.messageId, displayItems, 1))
                                }}
                            >
                                ›
                            </button>
                        </>
                    )}
                    <div className="lightbox-media" onClick={stopTileAction}>
                        <div
                            className={`lightbox-stage${isPdfFile(lightbox) ? ' is-embed' : ''}`}
                        >
                            <LightboxPreview item={lightbox} />
                        </div>
                    </div>
                    <div className="lightbox-info" onClick={stopTileAction}>
                        <strong>{lightbox.groupName}</strong>
                        <span className="lightbox-meta">{lightbox.senderName || 'Unknown sender'}</span>
                        <time className="lightbox-meta">{hkDateTime.format(lightbox.timestamp * 1000)}</time>
                        {displayItems.length > 1 && (
                            <span className="lightbox-meta">
                                {lightboxIndex + 1} of {displayItems.length}
                            </span>
                        )}
                        {lightbox.textContent && <p className="lightbox-copy">{lightbox.textContent}</p>}
                        {lightbox.fileName && <span className="lightbox-meta">{lightbox.fileName}</span>}
                        <a
                            href={lightbox.mediaUrl}
                            target="_blank"
                            rel="noreferrer"
                            download={lightbox.fileName || undefined}
                            className="download-button"
                        >
                            <DownloadIcon />
                            Download
                        </a>
                    </div>
                </div>,
                document.body
            )}
        </section>
    )
}
