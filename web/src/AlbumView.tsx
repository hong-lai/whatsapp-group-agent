import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'

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
    onSelectGroup: (jid: string) => void
    scope: AlbumScope
    onScopeChange: (scope: AlbumScope) => void
    types: MediaCategory[]
    onTypesChange: (types: MediaCategory[]) => void
}

export const allMediaCategories: MediaCategory[] = ['image', 'video', 'document', 'audio', 'sticker']

const categoryOptions: Array<{
    id: MediaCategory
    label: string
    icon: string
}> = [
    { id: 'image', label: 'Images', icon: '▧' },
    { id: 'video', label: 'Videos', icon: '▶' },
    { id: 'document', label: 'PDFs / Docs', icon: '▤' },
    { id: 'audio', label: 'Audio', icon: '♪' },
    { id: 'sticker', label: 'Stickers', icon: '◇' },
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
    timeStyle: 'short',
})

function albumUrl(
    from: string,
    to: string,
    scope: AlbumScope,
    selectedJid: string | null,
    types: MediaCategory[],
    cursor?: string
): string {
    const params = new URLSearchParams({ from, to, types: types.join(',') })
    if (scope === 'group' && selectedJid) params.set('group', selectedJid)
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

    function onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onToggle()
        }
    }

    return (
        <article
            className={`album-tile ${selected ? 'selected' : ''}`}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={`${selected ? 'Deselect' : 'Select'} ${item.category} from ${item.groupName}`}
            onClick={onToggle}
            onKeyDown={onKeyDown}
        >
            <span className="tile-select" aria-hidden="true">
                {selected ? '✓' : ''}
            </span>
            {visual ? (
                <div className="album-preview">
                    {item.category === 'video' ? (
                        <>
                            <video src={item.mediaUrl} muted preload="metadata" />
                            <span className="video-mark">▶</span>
                        </>
                    ) : (
                        <img src={item.mediaUrl} alt={item.textContent || item.category} loading="lazy" />
                    )}
                    <button
                        className="tile-expand"
                        type="button"
                        aria-label="View full screen"
                        onClick={(event) => {
                            stopTileAction(event)
                            onOpen()
                        }}
                    >
                        ⤢
                    </button>
                </div>
            ) : (
                <div className={`album-file-card ${item.category}`}>
                    <span className="file-glyph">
                        {item.category === 'audio' ? '♪' : 'PDF'}
                    </span>
                    <span>{item.category === 'audio' ? 'Audio message' : 'Shared document'}</span>
                    {item.category === 'audio' && (
                        <audio src={item.mediaUrl} controls preload="none" onClick={stopTileAction} />
                    )}
                    {item.category === 'document' && (
                        <a
                            href={item.mediaUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={stopTileAction}
                        >
                            Open document ↗
                        </a>
                    )}
                </div>
            )}
            <div className="album-tile-meta">
                <strong>{item.groupName}</strong>
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
    onSelectGroup,
    scope,
    onScopeChange,
    types,
    onTypesChange,
}: Props) {
    const [items, setItems] = useState<AlbumItem[]>([])
    const [counts, setCounts] = useState<Record<MediaCategory, number>>(emptyCounts)
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [lightbox, setLightbox] = useState<AlbumItem | null>(null)
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [downloading, setDownloading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const requestId = useRef(0)
    const showingAll = isAllTypes(types)

    const scopeGroup = scope === 'group' ? selectedJid : null
    const filterKey = `${from}|${to}|${scope}|${scopeGroup || ''}|${types.join(',')}`

    useEffect(() => {
        setSelected(new Set())
        setLightbox(null)
        if (scope === 'group' && !selectedJid) {
            requestId.current += 1
            setItems([])
            setLoading(false)
            return
        }
        const controller = new AbortController()
        const currentRequest = ++requestId.current
        setLoading(true)
        setError(null)
        albumJson(albumUrl(from, to, scope, selectedJid, types), controller.signal)
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
    }, [filterKey, from, to, scope, selectedJid, types])

    const selectedItems = useMemo(
        () => items.filter((item) => selected.has(item.messageId)),
        [items, selected]
    )

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
        setLoadingMore(true)
        setError(null)
        try {
            const data = await albumJson(
                albumUrl(from, to, scope, selectedJid, types, nextCursor)
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
        setDownloading(true)
        setError(null)
        try {
            const params = new URLSearchParams({ from, to, types: types.join(',') })
            if (scopeGroup) params.set('group', scopeGroup)
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
                    <span>From</span>
                    <div className="segmented-control">
                        <button
                            className={scope === 'all' ? 'active' : ''}
                            onClick={() => onScopeChange('all')}
                        >
                            All groups
                        </button>
                        <button
                            className={scope === 'group' ? 'active' : ''}
                            onClick={() => onScopeChange('group')}
                        >
                            This group
                        </button>
                    </div>
                    {scope === 'group' && (
                        <select
                            value={selectedJid || ''}
                            onChange={(event) => onSelectGroup(event.target.value)}
                            aria-label="Media group"
                        >
                            {groups.map((group) => (
                                <option value={group.jid} key={group.jid}>
                                    {group.name}
                                </option>
                            ))}
                        </select>
                    )}
                </div>
                <div className="album-actions">
                    <button
                        type="button"
                        onClick={selectAllVisible}
                        disabled={items.length === 0 || allVisibleSelected}
                    >
                        {allVisibleSelected ? 'All selected' : 'Select all'}
                    </button>
                </div>
            </header>

            <div className="media-filters" aria-label="Media type filters">
                <button
                    className={showingAll ? 'active' : ''}
                    onClick={() => {
                        if (!showingAll) onTypesChange([...allMediaCategories])
                    }}
                    aria-pressed={showingAll}
                >
                    <span>All types</span>
                    <strong>{Object.values(counts).reduce((sum, count) => sum + count, 0)}</strong>
                </button>
                {categoryOptions.map((category) => (
                    <button
                        key={category.id}
                        className={!showingAll && types.includes(category.id) ? 'active' : ''}
                        onClick={() => toggleType(category.id)}
                        aria-pressed={!showingAll && types.includes(category.id)}
                    >
                        <span className="filter-icon">{category.icon}</span>
                        <span>{category.label}</span>
                        <strong>{counts[category.id]}</strong>
                    </button>
                ))}
            </div>

            {error && <div className="album-error" role="alert">{error}</div>}

            <div className={`album-scroll ${showOverlay ? 'is-loading' : ''}`}>
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
                        <div className="album-grid">
                            {items.map((item) => (
                                <MediaTile
                                    item={item}
                                    selected={selected.has(item.messageId)}
                                    onToggle={() => toggleSelected(item.messageId)}
                                    onOpen={() => setLightbox(item)}
                                    key={item.messageId}
                                />
                            ))}
                        </div>
                        {nextCursor && (
                            <button className="load-more" onClick={loadMore} disabled={loadingMore}>
                                {loadingMore ? 'Loading…' : 'Load more'}
                            </button>
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
                    <button onClick={() => setSelected(new Set())}>Clear</button>
                    <button className="download-button" onClick={downloadZip} disabled={downloading}>
                        {downloading ? 'Preparing ZIP…' : 'Download ZIP'}
                    </button>
                </div>
            )}

            {lightbox && (
                <div className="lightbox" role="dialog" aria-modal="true" aria-label="Full screen media">
                    <button className="lightbox-close" onClick={() => setLightbox(null)} aria-label="Close">
                        ×
                    </button>
                    <div className="lightbox-media">
                        {lightbox.category === 'video' ? (
                            <video src={lightbox.mediaUrl} controls autoPlay />
                        ) : (
                            <img src={lightbox.mediaUrl} alt={lightbox.textContent || lightbox.category} />
                        )}
                    </div>
                    <div className="lightbox-info">
                        <strong>{lightbox.groupName}</strong>
                        <span>{lightbox.senderName || 'Unknown sender'}</span>
                        <time>{hkDateTime.format(lightbox.timestamp * 1000)}</time>
                        {lightbox.textContent && <p>{lightbox.textContent}</p>}
                        <button onClick={() => toggleSelected(lightbox.messageId)}>
                            {selected.has(lightbox.messageId) ? 'Remove from selection' : 'Select this media'}
                        </button>
                    </div>
                </div>
            )}
        </section>
    )
}
