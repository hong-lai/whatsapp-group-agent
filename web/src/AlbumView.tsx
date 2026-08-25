import { useEffect, useMemo, useRef, useState } from 'react'

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

const categoryOptions: Array<{
    id: MediaCategory
    label: string
    shortLabel: string
    icon: string
}> = [
    { id: 'image', label: 'Images', shortLabel: 'IMG', icon: '▧' },
    { id: 'video', label: 'Videos', shortLabel: 'VID', icon: '▶' },
    { id: 'document', label: 'PDFs / Docs', shortLabel: 'DOC', icon: '▤' },
    { id: 'audio', label: 'Audio', shortLabel: 'AUD', icon: '♪' },
    { id: 'sticker', label: 'Stickers', shortLabel: 'STK', icon: '◇' },
]

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

function initials(name: string): string {
    return (
        name
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase())
            .join('') || '?'
    )
}

async function albumJson(url: string, signal?: AbortSignal): Promise<AlbumResponse> {
    const response = await fetch(url, { signal })
    const body = (await response.json()) as AlbumResponse
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
    return body
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
                className="tile-select"
                aria-label={`${selected ? 'Deselect' : 'Select'} ${item.category}`}
                aria-pressed={selected}
                onClick={onToggle}
            >
                {selected ? '✓' : ''}
            </button>
            {visual ? (
                <button className="album-preview" onClick={onOpen} aria-label="Open media preview">
                    {item.category === 'video' ? (
                        <>
                            <video src={item.mediaUrl} muted preload="metadata" />
                            <span className="video-mark">▶</span>
                        </>
                    ) : (
                        <img src={item.mediaUrl} alt={item.textContent || item.category} loading="lazy" />
                    )}
                </button>
            ) : (
                <div className={`album-file-card ${item.category}`}>
                    <span className="file-glyph">
                        {item.category === 'audio' ? '♪' : 'PDF'}
                    </span>
                    <span>{item.category === 'audio' ? 'Audio message' : 'Shared document'}</span>
                    {item.category === 'audio' && (
                        <audio src={item.mediaUrl} controls preload="none" />
                    )}
                    {item.category === 'document' && (
                        <a href={item.mediaUrl} target="_blank" rel="noreferrer">
                            Open document ↗
                        </a>
                    )}
                </div>
            )}
            <div className="album-tile-meta">
                <div>
                    <span className="album-group-avatar">{initials(item.groupName)}</span>
                    <span>
                        <strong>{item.groupName}</strong>
                        <small>{item.senderName || 'Unknown sender'}</small>
                    </span>
                </div>
                <time>{hkDateTime.format(item.timestamp * 1000)}</time>
                {item.textContent && <p>{item.textContent}</p>}
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
    const [counts, setCounts] = useState<Record<MediaCategory, number>>({
        image: 0,
        video: 0,
        document: 0,
        audio: 0,
        sticker: 0,
    })
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [lightbox, setLightbox] = useState<AlbumItem | null>(null)
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [downloading, setDownloading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const requestId = useRef(0)

    const scopeGroup = scope === 'group' ? selectedJid : null
    const filterKey = `${from}|${to}|${scope}|${scopeGroup || ''}|${types.join(',')}`

    useEffect(() => {
        setSelected(new Set())
        setLightbox(null)
        if (scope === 'group' && !selectedJid) {
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
                    setError(reason instanceof Error ? reason.message : 'Could not load album')
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
        if (types.includes(category)) {
            if (types.length === 1) return
            onTypesChange(types.filter((item) => item !== category))
        } else {
            onTypesChange([...types, category])
        }
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

    return (
        <section className="album-panel" aria-busy={loading}>
            <header className="album-toolbar">
                <div className="album-scope">
                    <span>Show media from</span>
                    <div className="segmented-control">
                        <button
                            className={scope === 'all' ? 'active' : ''}
                            onClick={() => onScopeChange('all')}
                        >
                            All matching
                        </button>
                        <button
                            className={scope === 'group' ? 'active' : ''}
                            onClick={() => onScopeChange('group')}
                        >
                            One group
                        </button>
                    </div>
                    {scope === 'group' && (
                        <select
                            value={selectedJid || ''}
                            onChange={(event) => onSelectGroup(event.target.value)}
                            aria-label="Album group"
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
                        onClick={() =>
                            setSelected(
                                selected.size === items.length
                                    ? new Set()
                                    : new Set(items.map((item) => item.messageId))
                            )
                        }
                        disabled={items.length === 0}
                    >
                        {selected.size === items.length && items.length ? 'Clear selection' : 'Select loaded'}
                    </button>
                </div>
            </header>

            <div className="media-filters" aria-label="Media type filters">
                {categoryOptions.map((category) => (
                    <button
                        key={category.id}
                        className={types.includes(category.id) ? 'active' : ''}
                        onClick={() => toggleType(category.id)}
                        aria-pressed={types.includes(category.id)}
                    >
                        <span className="filter-icon">{category.icon}</span>
                        <span>{category.label}</span>
                        <strong>{counts[category.id]}</strong>
                    </button>
                ))}
            </div>

            {error && <div className="album-error" role="alert">{error}</div>}

            <div className="album-scroll">
                {loading && items.length === 0 ? (
                    <div className="album-grid">
                        {[1, 2, 3, 4, 5, 6].map((item) => (
                            <div className="album-tile album-skeleton skeleton" key={item} />
                        ))}
                    </div>
                ) : items.length ? (
                    <>
                        {loading && <div className="refresh-indicator album-refresh"><span />Updating</div>}
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
                                {loadingMore ? 'Loading…' : 'Load more media'}
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
                <div className="lightbox" role="dialog" aria-modal="true" aria-label="Media preview">
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

