import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import AlbumView, { allMediaCategories, type AlbumScope, type MediaCategory } from './AlbumView'
import { mergeFirstPage, useVisibleInterval } from './useVisibleInterval'

type Group = {
    jid: string
    name: string
    tracked: boolean
    deletedAt: string | null
    messageCount: number
    senderCount: number
    latestTimestamp: number | null
    latestText: string | null
}

type Reaction = {
    emoji: string
    count: number
    senders: string[]
}

type Message = {
    messageId: string
    senderJid: string | null
    senderName: string | null
    messageType: string
    textContent: string | null
    replyToId: string | null
    quotedMessage: string | null
    timestamp: number
    isEdited: boolean
    isDeleted: boolean
    isHistory: boolean
    hasMedia: boolean
    reactions: Reaction[]
    albumItems?: Message[]
}

type GroupsResponse = {
    groups: Group[]
    pattern: {
        source: string
        flags: string
    }
}

type MessagesResponse = {
    messages: Message[]
    nextCursor: string | null
}

function initialMediaCategories(params: URLSearchParams): MediaCategory[] {
    const requested = params.get('types')?.split(',') || []
    const valid = requested.filter((item): item is MediaCategory =>
        allMediaCategories.includes(item as MediaCategory)
    )
    return valid.length ? [...new Set(valid)] : allMediaCategories
}

const hkDateTime = new Intl.DateTimeFormat('en-HK', {
    timeZone: 'Asia/Hong_Kong',
    dateStyle: 'medium',
    timeStyle: 'medium',
})

const shortHkDate = new Intl.DateTimeFormat('en-HK', {
    timeZone: 'Asia/Hong_Kong',
    month: 'short',
    day: 'numeric',
})

function hongKongDate(timestamp = Date.now()): string {
    const shifted = new Date(timestamp + 8 * 60 * 60 * 1000)
    return [
        shifted.getUTCFullYear(),
        String(shifted.getUTCMonth() + 1).padStart(2, '0'),
        String(shifted.getUTCDate()).padStart(2, '0'),
    ].join('-')
}

function addDays(date: string, days: number): string {
    const [year, month, day] = date.split('-').map(Number)
    return hongKongDate(Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000 + days * 86400000)
}

function initials(name: string): string {
    const letters = name
        .trim()
        .split(/\s+/)
        .filter((part) => /\p{L}/u.test(part))
        .slice(0, 2)
        .map((part) => part.match(/\p{L}/u)?.[0]?.toUpperCase())
        .filter((letter): letter is string => Boolean(letter))
    return letters.join('') || '?'
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, { signal })
    const body = (await response.json()) as T & { error?: string }
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
    return body
}

function Icon({ name }: { name: 'archive' | 'calendar' | 'search' | 'users' | 'message' }) {
    const paths = {
        archive: (
            <>
                <path d="M4 7.5h16v12H4z" />
                <path d="M3 4.5h18v3H3zM9 11h6" />
            </>
        ),
        calendar: (
            <>
                <rect x="3" y="5" width="18" height="16" rx="2" />
                <path d="M16 3v4M8 3v4M3 10h18" />
            </>
        ),
        search: (
            <>
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-4-4" />
            </>
        ),
        users: (
            <>
                <circle cx="9" cy="8" r="3" />
                <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5v1" />
            </>
        ),
        message: (
            <>
                <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
                <path d="M8 9h8M8 13h5" />
            </>
        ),
    }

    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            {paths[name]}
        </svg>
    )
}

function MediaPreview({ message }: { message: Message }) {
    if (!message.hasMedia) return null
    const url = `/api/media/${encodeURIComponent(message.messageId)}`
    const type = message.messageType

    if (type === 'imageMessage' || type === 'stickerMessage') {
        return (
            <a className="media-frame" href={url} target="_blank" rel="noreferrer">
                <img src={url} alt={message.textContent || 'Shared media'} loading="lazy" />
            </a>
        )
    }
    if (type === 'videoMessage') {
        return <video className="media-frame" src={url} controls preload="metadata" />
    }
    if (type === 'audioMessage') {
        return <audio className="audio-player" src={url} controls preload="metadata" />
    }
    return (
        <a className="document-link" href={url} target="_blank" rel="noreferrer">
            <span className="document-icon">PDF</span>
            <span>
                <strong>Open document</strong>
                <small>Shared attachment</small>
            </span>
            <span aria-hidden="true">↗</span>
        </a>
    )
}

function albumSummary(items: Message[]): string {
    const photos = items.filter((item) => item.messageType === 'imageMessage').length
    const videos = items.filter((item) => item.messageType === 'videoMessage').length
    const parts = []
    if (photos) parts.push(`${photos} photo${photos === 1 ? '' : 's'}`)
    if (videos) parts.push(`${videos} video${videos === 1 ? '' : 's'}`)
    return parts.join(' · ') || 'Album'
}

function mediaUrl(messageId: string): string {
    return `/api/media/${encodeURIComponent(messageId)}`
}

function ConversationAlbum({
    items,
    includeDeleted = false,
}: {
    items: Message[]
    includeDeleted?: boolean
}) {
    const visible = items.filter((item) => (includeDeleted || !item.isDeleted) && item.hasMedia)
    const preview = visible.slice(0, 4)
    const extra = visible.length - preview.length
    const [openIndex, setOpenIndex] = useState<number | null>(null)
    const openItem = openIndex === null ? null : visible[openIndex]

    useEffect(() => {
        if (openIndex === null) return undefined
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpenIndex(null)
            if (event.key === 'ArrowRight') {
                setOpenIndex((current) =>
                    current === null ? current : (current + 1) % visible.length
                )
            }
            if (event.key === 'ArrowLeft') {
                setOpenIndex((current) =>
                    current === null ? current : (current - 1 + visible.length) % visible.length
                )
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [openIndex, visible.length])

    if (visible.length === 0) {
        return <p className="album-pending">Grouped photos or videos</p>
    }

    return (
        <>
            <div
                className={`conversation-album count-${Math.min(preview.length, 4)}`}
                aria-label={albumSummary(visible)}
            >
                {preview.map((item, index) => {
                    const url = mediaUrl(item.messageId)
                    const isVideo = item.messageType === 'videoMessage'
                    const showMore = extra > 0 && index === preview.length - 1
                    return (
                        <button
                            className={`conversation-album-tile ${isVideo ? 'video' : ''}`}
                            key={item.messageId}
                            type="button"
                            onClick={() => setOpenIndex(index)}
                            aria-label={
                                showMore
                                    ? `Open album, ${extra} more`
                                    : isVideo
                                      ? 'Open video'
                                      : 'Open photo'
                            }
                        >
                            {isVideo ? (
                                <video src={url} preload="metadata" muted playsInline />
                            ) : (
                                <img src={url} alt={item.textContent || 'Album photo'} loading="lazy" />
                            )}
                            {isVideo && !showMore && (
                                <span className="conversation-album-play" aria-hidden="true">
                                    ▶
                                </span>
                            )}
                            {showMore && (
                                <span className="conversation-album-more">+{extra}</span>
                            )}
                        </button>
                    )
                })}
            </div>
            {openItem && openIndex !== null && (
                <div className="lightbox" role="dialog" aria-modal="true" aria-label="Album preview">
                    <button className="lightbox-close" onClick={() => setOpenIndex(null)} aria-label="Close">
                        ×
                    </button>
                    {visible.length > 1 && (
                        <>
                            <button
                                className="lightbox-nav prev"
                                type="button"
                                aria-label="Previous"
                                onClick={() =>
                                    setOpenIndex((openIndex - 1 + visible.length) % visible.length)
                                }
                            >
                                ‹
                            </button>
                            <button
                                className="lightbox-nav next"
                                type="button"
                                aria-label="Next"
                                onClick={() => setOpenIndex((openIndex + 1) % visible.length)}
                            >
                                ›
                            </button>
                        </>
                    )}
                    <div className="lightbox-media">
                        {openItem.messageType === 'videoMessage' ? (
                            <video src={mediaUrl(openItem.messageId)} controls autoPlay />
                        ) : (
                            <img
                                src={mediaUrl(openItem.messageId)}
                                alt={openItem.textContent || 'Album photo'}
                            />
                        )}
                    </div>
                    <div className="lightbox-info">
                        <strong>{albumSummary(visible)}</strong>
                        <span>
                            {openIndex + 1} of {visible.length}
                        </span>
                        {openItem.textContent && <p>{openItem.textContent}</p>}
                        <a
                            href={mediaUrl(openItem.messageId)}
                            target="_blank"
                            rel="noreferrer"
                        >
                            Open original
                        </a>
                    </div>
                </div>
            )}
        </>
    )
}

function hasStoredContent(message: Message): boolean {
    if (message.textContent || message.hasMedia || message.quotedMessage) return true
    return (message.albumItems ?? []).some((item) => item.hasMedia || item.textContent)
}

function MessageBody({ message, revealed }: { message: Message; revealed: boolean }) {
    const albumItems = message.albumItems ?? []
    const caption =
        message.textContent || albumItems.find((item) => item.textContent)?.textContent

    if (message.isDeleted && !revealed) {
        return <p className="deleted-copy">This message was deleted.</p>
    }
    if (message.messageType === 'albumMessage') {
        return (
            <>
                {caption && <p>{caption}</p>}
                <ConversationAlbum items={albumItems} includeDeleted={revealed} />
            </>
        )
    }
    return (
        <>
            {caption ? <p>{caption}</p> : message.hasMedia ? null : <p>No text content</p>}
            <MediaPreview message={message} />
        </>
    )
}

function MessageCard({ message }: { message: Message }) {
    const [revealed, setRevealed] = useState(false)
    const canReveal = message.isDeleted && hasStoredContent(message)

    return (
        <article className={`message-card ${message.isDeleted ? 'deleted' : ''} ${revealed ? 'revealed' : ''}`}>
            <span className="sender-avatar">
                {initials(message.senderName || message.senderJid || 'Unknown')}
            </span>
            <div className="message-content">
                <header>
                    <strong>{message.senderName || message.senderJid || 'Unknown sender'}</strong>
                    <time>{hkDateTime.format(message.timestamp * 1000)}</time>
                </header>
                <div className="badges">
                    {message.isEdited && <span>Edited</span>}
                    {message.isHistory && <span>History</span>}
                    {message.isDeleted && <span>Deleted</span>}
                    <span>
                        {message.messageType === 'albumMessage'
                            ? albumSummary(message.albumItems ?? [])
                            : message.messageType.replace(/Message$/, '')}
                    </span>
                </div>
                {message.quotedMessage && (!message.isDeleted || revealed) && (
                    <blockquote>{message.quotedMessage}</blockquote>
                )}
                <MessageBody message={message} revealed={revealed} />
                {canReveal && (
                    <button
                        type="button"
                        className="reveal-original"
                        onClick={() => setRevealed((current) => !current)}
                    >
                        {revealed ? 'Hide original' : 'Reveal original'}
                    </button>
                )}
                {(!message.isDeleted || revealed) && (
                    <ReactionRow reactions={message.reactions ?? []} />
                )}
            </div>
        </article>
    )
}

function ReactionRow({ reactions }: { reactions: Reaction[] }) {
    if (reactions.length === 0) return null

    return (
        <div className="reaction-row">
            {reactions.map((reaction) => (
                <span
                    className="reaction-chip"
                    key={reaction.emoji}
                    title={`${reaction.emoji} ${reaction.senders.join(', ')}`}
                >
                    <span className="reaction-emoji">{reaction.emoji}</span>
                    {reaction.count > 1 && <span className="reaction-count">{reaction.count}</span>}
                </span>
            ))}
        </div>
    )
}

function SkeletonMessages() {
    return (
        <div className="message-list" aria-label="Loading messages">
            {[1, 2, 3].map((item) => (
                <div className="message-card skeleton-card" key={item}>
                    <div className="skeleton avatar-skeleton" />
                    <div className="skeleton-body">
                        <div className="skeleton short" />
                        <div className="skeleton" />
                        <div className="skeleton medium" />
                    </div>
                </div>
            ))}
        </div>
    )
}

export default function App() {
    const initialParams = new URLSearchParams(window.location.search)
    const today = hongKongDate()
    const [from, setFrom] = useState(initialParams.get('from') || addDays(today, -1))
    const [to, setTo] = useState(initialParams.get('to') || today)
    const [selectedJid, setSelectedJid] = useState<string | null>(initialParams.get('group'))
    const [view, setView] = useState<'messages' | 'album'>(
        initialParams.get('view') === 'album' ? 'album' : 'messages'
    )
    const [albumScope, setAlbumScope] = useState<AlbumScope>(
        initialParams.get('scope') === 'group' ? 'group' : 'all'
    )
    const [albumTypes, setAlbumTypes] = useState<MediaCategory[]>(
        initialMediaCategories(initialParams)
    )
    const [search, setSearch] = useState('')
    const [groups, setGroups] = useState<Group[]>([])
    const [messages, setMessages] = useState<Message[]>([])
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [groupsLoading, setGroupsLoading] = useState(true)
    const [messagesLoading, setMessagesLoading] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [reloadKey, setReloadKey] = useState(0)
    const [livePulse, setLivePulse] = useState(false)
    const [pattern, setPattern] = useState<{ source: string; flags: string } | null>(null)
    const groupsRequestId = useRef(0)
    const messagesRequestId = useRef(0)
    const silentGen = useRef(0)
    const silentBusy = useRef(false)
    const pulseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    const lastPulse = useRef(0)
    const messageListRef = useRef<HTMLDivElement>(null)
    const scrollRestore = useRef<{ top: number; height: number } | null>(null)
    const nextCursorRef = useRef<string | null>(null)
    nextCursorRef.current = nextCursor

    const invalidRange = from > to
    const selectedGroup = groups.find((group) => group.jid === selectedJid) || null
    const filteredGroups = useMemo(() => {
        const needle = search.trim().toLocaleLowerCase()
        return needle
            ? groups.filter((group) => group.name.toLocaleLowerCase().includes(needle))
            : groups
    }, [groups, search])
    const totals = useMemo(
        () => ({
            messages: groups.reduce((sum, group) => sum + group.messageCount, 0),
            matchingGroups: groups.length,
        }),
        [groups]
    )
    const patternTerms = useMemo(
        () => (pattern?.source ? pattern.source.split('|').map((term) => term.trim()).filter(Boolean) : []),
        [pattern]
    )

    useEffect(() => {
        const params = new URLSearchParams()
        params.set('from', from)
        params.set('to', to)
        params.set('view', view)
        if (selectedJid) params.set('group', selectedJid)
        if (view === 'album') {
            params.set('scope', albumScope)
            params.set('types', albumTypes.join(','))
        }
        window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
    }, [from, to, selectedJid, view, albumScope, albumTypes])

    function pulseLive() {
        const now = Date.now()
        if (now - lastPulse.current < 400) return
        lastPulse.current = now
        setLivePulse(true)
        if (pulseTimer.current) clearTimeout(pulseTimer.current)
        pulseTimer.current = setTimeout(() => setLivePulse(false), 700)
    }

    useEffect(() => {
        return () => {
            silentGen.current += 1
            if (pulseTimer.current) clearTimeout(pulseTimer.current)
        }
    }, [])

    useLayoutEffect(() => {
        const pending = scrollRestore.current
        const list = messageListRef.current
        if (!pending || !list) return
        list.scrollTop = pending.top + (list.scrollHeight - pending.height)
        scrollRestore.current = null
    }, [messages])

    useEffect(() => {
        silentGen.current += 1
        if (invalidRange) {
            groupsRequestId.current += 1
            setGroupsLoading(false)
            return
        }
        const controller = new AbortController()
        const requestId = ++groupsRequestId.current
        setGroupsLoading(true)
        setError(null)
        getJson<GroupsResponse>(
            `/api/groups?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
            controller.signal
        )
            .then((data) => {
                if (requestId !== groupsRequestId.current) return
                setGroups(data.groups)
                if (data.pattern?.source) setPattern(data.pattern)
                setSelectedJid((current) => {
                    if (current && data.groups.some((group) => group.jid === current)) return current
                    return data.groups.find((group) => group.messageCount > 0)?.jid || data.groups[0]?.jid || null
                })
            })
            .catch((reason: unknown) => {
                if (
                    requestId === groupsRequestId.current &&
                    (reason as Error).name !== 'AbortError'
                ) {
                    setError(reason instanceof Error ? reason.message : 'Could not load groups')
                }
            })
            .finally(() => {
                if (requestId === groupsRequestId.current) setGroupsLoading(false)
            })
        return () => controller.abort()
    }, [from, to, invalidRange, reloadKey])

    useEffect(() => {
        silentGen.current += 1
        if (!selectedJid || invalidRange) {
            messagesRequestId.current += 1
            setMessagesLoading(false)
            if (!selectedJid) {
                setMessages([])
                setNextCursor(null)
            }
            return
        }
        const controller = new AbortController()
        const requestId = ++messagesRequestId.current
        scrollRestore.current = null
        setMessagesLoading(true)
        setError(null)
        getJson<MessagesResponse>(
            `/api/groups/${encodeURIComponent(selectedJid)}/messages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
            controller.signal
        )
            .then((data) => {
                if (requestId !== messagesRequestId.current) return
                setMessages(data.messages)
                setNextCursor(data.nextCursor)
            })
            .catch((reason: unknown) => {
                if (
                    requestId === messagesRequestId.current &&
                    (reason as Error).name !== 'AbortError'
                ) {
                    setError(reason instanceof Error ? reason.message : 'Could not load messages')
                }
            })
            .finally(() => {
                if (requestId === messagesRequestId.current) setMessagesLoading(false)
            })
        return () => controller.abort()
    }, [selectedJid, from, to, invalidRange, reloadKey])

    async function silentRefresh() {
        if (
            invalidRange ||
            groupsLoading ||
            messagesLoading ||
            loadingMore ||
            silentBusy.current
        ) {
            return
        }
        const gen = ++silentGen.current
        const rangeFrom = from
        const rangeTo = to
        const jid = selectedJid
        const currentView = view
        silentBusy.current = true
        try {
            const groupsData = await getJson<GroupsResponse>(
                `/api/groups?from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}`
            )
            if (gen !== silentGen.current) return
            setGroups(groupsData.groups)
            if (groupsData.pattern?.source) setPattern(groupsData.pattern)
            setSelectedJid((current) => {
                if (!current) {
                    return (
                        groupsData.groups.find((group) => group.messageCount > 0)?.jid ||
                        groupsData.groups[0]?.jid ||
                        null
                    )
                }
                if (groupsData.groups.some((group) => group.jid === current)) return current
                return (
                    groupsData.groups.find((group) => group.messageCount > 0)?.jid ||
                    groupsData.groups[0]?.jid ||
                    null
                )
            })
            setError(null)

            if (currentView === 'messages' && jid) {
                const messagesData = await getJson<MessagesResponse>(
                    `/api/groups/${encodeURIComponent(jid)}/messages?from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}`
                )
                if (gen !== silentGen.current) return
                const list = messageListRef.current
                if (list && list.scrollTop > 40) {
                    scrollRestore.current = { top: list.scrollTop, height: list.scrollHeight }
                } else {
                    scrollRestore.current = null
                }
                setMessages((current) => {
                    const merged = mergeFirstPage(current, messagesData.messages)
                    nextCursorRef.current = merged.keptTail
                        ? nextCursorRef.current
                        : messagesData.nextCursor
                    return merged.items
                })
                setNextCursor(nextCursorRef.current)
            }
            pulseLive()
        } catch (reason: unknown) {
            if ((reason as Error).name === 'AbortError') return
        } finally {
            silentBusy.current = false
        }
    }

    useVisibleInterval(silentRefresh, 10_000)

    async function loadMore() {
        if (!selectedJid || !nextCursor || loadingMore) return
        silentGen.current += 1
        setLoadingMore(true)
        try {
            const data = await getJson<MessagesResponse>(
                `/api/groups/${encodeURIComponent(selectedJid)}/messages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&cursor=${encodeURIComponent(nextCursor)}`
            )
            setMessages((current) => [...current, ...data.messages])
            setNextCursor(data.nextCursor)
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not load more messages')
        } finally {
            setLoadingMore(false)
        }
    }

    function applyPreset(days: number) {
        setTo(today)
        setFrom(addDays(today, -(days - 1)))
    }

    return (
        <div className="app-shell">
            <header className="topbar">
                <div className="brand">
                    <span className="brand-mark">
                        <Icon name="archive" />
                    </span>
                    <span>
                        <strong>Group Archive</strong>
                        <small>WhatsApp message dashboard</small>
                    </span>
                </div>
                <div className="topbar-status">
                    {pattern && (
                        <div
                            className="pattern-meta"
                            title={`GROUP_PATTERN /${pattern.source}/${pattern.flags}`}
                        >
                            <span>Matching</span>
                            {patternTerms.map((term) => (
                                <code key={term}>{term}</code>
                            ))}
                        </div>
                    )}
                    <span className={`status-dot${livePulse ? ' is-live' : ''}`} />
                    Connected
                </div>
            </header>

            <section className="hero">
                <div>
                    <h1>Group messages and media.</h1>
                    <p className="hero-copy">
                        Only groups whose names match the configured pattern are shown.
                    </p>
                </div>
                <div className="summary-cards">
                    <div className="summary-card">
                        <span className="summary-icon"><Icon name="message" /></span>
                        <span><strong>{totals.messages.toLocaleString()}</strong><small>Messages in range</small></span>
                    </div>
                    <div className="summary-card">
                        <span className="summary-icon"><Icon name="users" /></span>
                        <span><strong>{totals.matchingGroups}</strong><small>Matching groups</small></span>
                    </div>
                </div>
            </section>

            <section className="filter-bar" aria-label="Date filters">
                <div className="date-control">
                    <Icon name="calendar" />
                    <label>
                        <span>From</span>
                        <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
                    </label>
                    <span className="date-arrow">→</span>
                    <label>
                        <span>To</span>
                        <input type="date" value={to} min={from} max={today} onChange={(event) => setTo(event.target.value)} />
                    </label>
                </div>
                <div className="view-switch" aria-label="Dashboard view">
                    <button
                        className={view === 'messages' ? 'active' : ''}
                        onClick={() => setView('messages')}
                    >
                        Messages
                    </button>
                    <button
                        className={view === 'album' ? 'active' : ''}
                        onClick={() => setView('album')}
                    >
                        Media
                    </button>
                </div>
                <div className="presets" aria-label="Date presets">
                    {[1, 2, 7, 30].map((days) => (
                        <button
                            className={from === addDays(today, -(days - 1)) && to === today ? 'active' : ''}
                            key={days}
                            onClick={() => applyPreset(days)}
                        >
                            {days === 1 ? 'Today' : `${days} days`}
                        </button>
                    ))}
                </div>
                {invalidRange && <p className="inline-error">Choose a valid date range.</p>}
            </section>

            {error && (
                <div className="error-banner" role="alert">
                    <span>{error}</span>
                    <button onClick={() => setReloadKey((key) => key + 1)}>Try again</button>
                </div>
            )}

            <main
                className={`dashboard ${view === 'album' ? 'album-dashboard' : ''}`}
                aria-busy={groupsLoading || messagesLoading}
            >
                <div className="view-pane messages-pane" hidden={view !== 'messages'}>
                    <aside className="groups-panel">
                    <div className="panel-heading">
                        <div>
                            <h2>Groups</h2>
                        </div>
                        <span className="count-pill">{groups.length}</span>
                    </div>
                    <label className="search-box">
                        <Icon name="search" />
                        <input
                            type="search"
                            placeholder="Search groups"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                        />
                    </label>

                    <div className={`group-list ${groupsLoading && groups.length > 0 ? 'is-loading' : ''}`}>
                        {groupsLoading && groups.length > 0 && (
                            <div className="content-overlay" role="status">
                                <span className="overlay-spinner" />
                                Updating
                            </div>
                        )}
                        {groupsLoading &&
                            groups.length === 0 &&
                            [1, 2, 3].map((item) => <div className="group-item skeleton-group skeleton" key={item} />)}
                        {filteredGroups.map((group) => (
                                <button
                                    className={`group-item ${group.jid === selectedJid ? 'selected' : ''}`}
                                    key={group.jid}
                                    onClick={() => setSelectedJid(group.jid)}
                                >
                                    <span className="group-avatar">{initials(group.name)}</span>
                                    <span className="group-copy">
                                        <span className="group-title-row">
                                            <strong>{group.name}</strong>
                                            {!group.tracked && <span className="inactive-dot" title="Inactive group" />}
                                        </span>
                                        <span className="group-preview">
                                            {group.latestText || (group.messageCount ? 'Media message' : 'No messages in range')}
                                        </span>
                                        <span className="group-meta">
                                            <span>{group.messageCount} messages</span>
                                            <span>{group.senderCount} senders</span>
                                        </span>
                                    </span>
                                    <span className="group-date">
                                        {group.latestTimestamp
                                            ? shortHkDate.format(group.latestTimestamp * 1000)
                                            : '—'}
                                    </span>
                                </button>
                            ))}
                        {!groupsLoading && filteredGroups.length === 0 && (
                            <div className="empty-small">
                                {search.trim()
                                    ? 'No matching groups for this search.'
                                    : 'No groups match the configured name pattern.'}
                            </div>
                        )}
                    </div>
                </aside>

                <section className="messages-panel">
                    {selectedGroup ? (
                        <>
                            <header className="messages-heading">
                                <span className="group-avatar large">{initials(selectedGroup.name)}</span>
                                <div>
                                    <div className="title-with-status">
                                        <h2>{selectedGroup.name}</h2>
                                        <span className={selectedGroup.tracked ? 'active-badge' : 'inactive-badge'}>
                                            {selectedGroup.tracked ? 'Active' : 'Inactive'}
                                        </span>
                                    </div>
                                    <p>
                                        {selectedGroup.messageCount} messages · {selectedGroup.senderCount} senders
                                    </p>
                                </div>
                            </header>

                            {messagesLoading && messages.length === 0 ? (
                                <SkeletonMessages />
                            ) : messages.length ? (
                                <div
                                    className={`message-list ${messagesLoading ? 'is-loading' : ''}`}
                                    ref={messageListRef}
                                >
                                    {messagesLoading && (
                                        <div className="content-overlay" role="status">
                                            <span className="overlay-spinner" />
                                            Updating
                                        </div>
                                    )}
                                    {messages.map((message) => (
                                        <MessageCard message={message} key={message.messageId} />
                                    ))}
                                    {nextCursor && (
                                        <button className="load-more" onClick={loadMore} disabled={loadingMore}>
                                            {loadingMore ? 'Loading…' : 'Load older messages'}
                                        </button>
                                    )}
                                </div>
                            ) : (
                                <div className="empty-state">
                                    <span className="empty-icon"><Icon name="message" /></span>
                                    <h3>No messages in this range</h3>
                                    <p>Try a wider date range or choose another group.</p>
                                    <button onClick={() => applyPreset(30)}>Show the last 30 days</button>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="empty-state">
                            <span className="empty-icon"><Icon name="users" /></span>
                            <h3>Select a group</h3>
                            <p>Choose a group to explore its archived messages and media.</p>
                        </div>
                    )}
                    </section>
                </div>
                <div className="view-pane media-pane" hidden={view !== 'album'}>
                    <AlbumView
                        from={from}
                        to={to}
                        groups={groups}
                        selectedJid={selectedJid}
                        onSelectGroup={setSelectedJid}
                        scope={albumScope}
                        onScopeChange={setAlbumScope}
                        types={albumTypes}
                        onTypesChange={setAlbumTypes}
                        active={view === 'album'}
                        onLiveUpdate={pulseLive}
                    />
                </div>
            </main>
        </div>
    )
}
