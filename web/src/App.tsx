import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import AlbumView, { allMediaCategories, type AlbumScope, type MediaCategory } from './AlbumView'
import { mergeFirstPage, useInfiniteScroll, useVisibleInterval } from './useVisibleInterval'

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
    fileName: string | null
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

type AgentConnectionState = 'connecting' | 'connected' | 'disconnected'

type AgentConnectionEvent = {
    type: 'disconnected' | 'reconnected'
    at: number
    detail?: string
}

type StatusResponse = {
    state: AgentConnectionState
    since: number
    events: AgentConnectionEvent[]
}

function initialMediaCategories(params: URLSearchParams): MediaCategory[] {
    const requested = params.get('types')?.split(',') || []
    const valid = requested.filter((item): item is MediaCategory =>
        allMediaCategories.includes(item as MediaCategory)
    )
    return valid.length ? [...new Set(valid)] : allMediaCategories
}

function initialAlbumGroups(params: URLSearchParams): string[] {
    const fromList = params.get('groups')
    if (fromList) {
        return [...new Set(fromList.split(',').map((jid) => jid.trim()).filter(Boolean))]
    }
    const one = params.get('group')
    return one && params.get('scope') === 'group' ? [one] : []
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

function Icon({ name }: { name: 'archive' | 'calendar' | 'search' | 'users' | 'message' | 'image' }) {
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
        image: (
            <>
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <circle cx="8.5" cy="10" r="1.5" />
                <path d="m21 16-5.5-5.5-4 4L9 12l-6 6" />
            </>
        ),
    }

    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            {paths[name]}
        </svg>
    )
}

function isContactMessage(type: string): boolean {
    return type === 'contactMessage' || type === 'contactsArrayMessage'
}

function isLocationMessage(type: string): boolean {
    return type === 'locationMessage' || type === 'liveLocationMessage'
}

function contactCards(text: string | null): Array<{ name: string; detail?: string }> {
    const blocks = (text || '').split(/\n{2,}/).map((block) => block.trim()).filter(Boolean)
    if (blocks.length === 0) return [{ name: 'Shared contact' }]
    return blocks.map((block) => {
        const [name, ...rest] = block.split('\n')
        return { name: name || 'Shared contact', detail: rest.join(' · ') || undefined }
    })
}

function locationShare(text: string | null): { title: string; detail?: string; mapsUrl?: string } {
    const lines = (text || '').split('\n').map((line) => line.trim()).filter(Boolean)
    const mapsUrl = lines.find((line) => /^https?:\/\//i.test(line))
    const copy = lines.filter((line) => line !== mapsUrl)
    return {
        title: copy[0] || 'Shared location',
        detail: copy.slice(1).join(' · ') || undefined,
        mapsUrl,
    }
}

function ConnectionStatus({
    state,
    events,
    live,
    unreachable,
}: {
    state: AgentConnectionState
    events: AgentConnectionEvent[]
    live?: boolean
    unreachable?: boolean
}) {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return undefined
        const onPointer = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
        }
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('mousedown', onPointer)
        window.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('mousedown', onPointer)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    const label =
        state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting' : 'Disconnected'

    return (
        <div className="connection-status" ref={rootRef}>
            <button
                type="button"
                className={`connection-toggle is-${state}`}
                aria-expanded={open}
                aria-haspopup="dialog"
                title="Connection log"
                onClick={() => setOpen((current) => !current)}
            >
                <span className={`status-dot is-${state}${live ? ' is-live' : ''}`} />
                {label}
            </button>
            {open && (
                <div className="connection-log" role="dialog" aria-label="Connection log">
                    <strong>Connection log</strong>
                    <p>Disconnect and reconnect times since this process started. Not stored.</p>
                    {unreachable && (
                        <div className="connection-empty">Dashboard cannot reach the agent right now.</div>
                    )}
                    {events.length === 0 && !unreachable ? (
                        <div className="connection-empty">No disconnects yet.</div>
                    ) : events.length > 0 ? (
                        <ol>
                            {events.map((event) => (
                                <li key={`${event.type}-${event.at}`} className={`is-${event.type}`}>
                                    <span>{event.type === 'reconnected' ? 'Reconnected' : 'Disconnected'}</span>
                                    <time>{hkDateTime.format(event.at)}</time>
                                    {event.detail && <small>{event.detail}</small>}
                                </li>
                            ))}
                        </ol>
                    ) : null}
                </div>
            )}
        </div>
    )
}

function fileExtensionLabel(fileName: string | null | undefined, fallback: string): string {
    const name = fileName?.trim()
    if (!name) return fallback
    const dot = name.lastIndexOf('.')
    const ext = dot >= 0 ? name.slice(dot + 1) : ''
    return (ext || fallback).slice(0, 5).toUpperCase()
}

function MediaPreview({ message }: { message: Message }) {
    if (!message.hasMedia) return null
    const url = `/api/media/${encodeURIComponent(message.messageId)}`
    const type = message.messageType
    const fileName = message.fileName || undefined

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
        <a className="document-link" href={url} target="_blank" rel="noreferrer" download={fileName}>
            <span className="document-icon">{fileExtensionLabel(message.fileName, 'PDF')}</span>
            <span>
                <strong>{message.fileName || 'Open document'}</strong>
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
                            <video
                                key={openItem.messageId}
                                src={mediaUrl(openItem.messageId)}
                                controls
                                autoPlay
                            />
                        ) : (
                            <img
                                key={openItem.messageId}
                                src={mediaUrl(openItem.messageId)}
                                alt={openItem.textContent || 'Album photo'}
                            />
                        )}
                    </div>
                    <div className="lightbox-info">
                        <strong>{albumSummary(visible)}</strong>
                        <span className="lightbox-meta">
                            {openIndex + 1} of {visible.length}
                        </span>
                        {openItem.textContent && (
                            <p className="lightbox-copy">{openItem.textContent}</p>
                        )}
                        <a
                            href={mediaUrl(openItem.messageId)}
                            target="_blank"
                            rel="noreferrer"
                            download={openItem.fileName || undefined}
                        >
                            Download
                        </a>
                    </div>
                </div>
            )}
        </>
    )
}

function hasStoredContent(message: Message): boolean {
    if (message.textContent || message.hasMedia || message.quotedMessage) return true
    if (isContactMessage(message.messageType) || isLocationMessage(message.messageType)) return true
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
    if (isContactMessage(message.messageType)) {
        return (
            <div className="share-stack">
                {contactCards(message.textContent).map((card, index) => (
                    <div className="share-card" key={`${card.name}-${index}`}>
                        <span className="share-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                                <circle cx="12" cy="8" r="3" />
                                <path d="M5 20v-1.5a7 7 0 0 1 14 0V20" />
                            </svg>
                        </span>
                        <span>
                            <strong>{card.name}</strong>
                            {card.detail && /^[+\d][\d\s()-]{5,}$/.test(card.detail) ? (
                                <small>
                                    <a href={`tel:${card.detail.replace(/[^\d+]/g, '')}`}>{card.detail}</a>
                                </small>
                            ) : (
                                <small>{card.detail || 'Contact card'}</small>
                            )}
                        </span>
                    </div>
                ))}
            </div>
        )
    }
    if (isLocationMessage(message.messageType)) {
        const place = locationShare(message.textContent)
        const live = message.messageType === 'liveLocationMessage'
        const body = (
            <>
                <span className="share-icon location" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                        <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z" />
                        <circle cx="12" cy="10" r="2.2" />
                    </svg>
                </span>
                <span>
                    <strong>{place.title}</strong>
                    <small>{place.detail || (live ? 'Live location' : 'Location pin')}</small>
                </span>
                {place.mapsUrl ? <span aria-hidden="true">↗</span> : null}
            </>
        )
        if (!place.mapsUrl) return <div className="share-card">{body}</div>
        return (
            <a className="share-card" href={place.mapsUrl} target="_blank" rel="noreferrer">
                {body}
            </a>
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
    const [albumGroupJids, setAlbumGroupJids] = useState<string[]>(
        initialAlbumGroups(initialParams)
    )
    const [albumTypes, setAlbumTypes] = useState<MediaCategory[]>(
        initialMediaCategories(initialParams)
    )
    const [search, setSearch] = useState('')
    const [showEmptyGroups, setShowEmptyGroups] = useState(initialParams.get('empty') === '1')
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
    const [agentState, setAgentState] = useState<AgentConnectionState>('connecting')
    const [connectionEvents, setConnectionEvents] = useState<AgentConnectionEvent[]>([])
    const [linkDown, setLinkDown] = useState(typeof navigator !== 'undefined' && !navigator.onLine)
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
    const connectionState: AgentConnectionState = linkDown ? 'disconnected' : agentState
    const rangedGroups = useMemo(
        () => (showEmptyGroups ? groups : groups.filter((group) => group.messageCount > 0)),
        [groups, showEmptyGroups]
    )
    const filteredGroups = useMemo(() => {
        const needle = search.trim().toLocaleLowerCase()
        return needle
            ? rangedGroups.filter((group) => group.name.toLocaleLowerCase().includes(needle))
            : rangedGroups
    }, [rangedGroups, search])
    const patternTerms = useMemo(
        () => (pattern?.source ? pattern.source.split('|').map((term) => term.trim()).filter(Boolean) : []),
        [pattern]
    )

    useEffect(() => {
        const params = new URLSearchParams()
        params.set('from', from)
        params.set('to', to)
        params.set('view', view)
        if (showEmptyGroups) params.set('empty', '1')
        if (selectedJid) params.set('group', selectedJid)
        if (view === 'album') {
            params.set('scope', albumScope)
            params.set('types', albumTypes.join(','))
            if (albumScope === 'group' && albumGroupJids.length) {
                params.set('groups', albumGroupJids.join(','))
            }
        }
        window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
    }, [from, to, selectedJid, view, albumScope, albumGroupJids, albumTypes, showEmptyGroups])

    useEffect(() => {
        if (groupsLoading) return
        if (selectedJid && rangedGroups.some((group) => group.jid === selectedJid)) return
        setSelectedJid(rangedGroups[0]?.jid ?? null)
    }, [groupsLoading, rangedGroups, selectedJid])

    function pulseLive() {
        const now = Date.now()
        if (now - lastPulse.current < 400) return
        lastPulse.current = now
        setLivePulse(true)
        if (pulseTimer.current) clearTimeout(pulseTimer.current)
        pulseTimer.current = setTimeout(() => setLivePulse(false), 700)
    }

    async function refreshConnection() {
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            setLinkDown(true)
            setAgentState('disconnected')
            return
        }
        try {
            const data = await getJson<StatusResponse>('/api/status')
            setLinkDown(false)
            setAgentState(data.state)
            setConnectionEvents(data.events)
        } catch {
            setLinkDown(true)
            setAgentState('disconnected')
        }
    }

    useVisibleInterval(refreshConnection, 4000)

    useEffect(() => {
        void refreshConnection()
        const onOffline = () => {
            setLinkDown(true)
            setAgentState('disconnected')
        }
        const onOnline = () => {
            setLinkDown(false)
            void refreshConnection()
        }
        window.addEventListener('offline', onOffline)
        window.addEventListener('online', onOnline)
        return () => {
            window.removeEventListener('offline', onOffline)
            window.removeEventListener('online', onOnline)
        }
    }, [])

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

    const olderSentinelRef = useInfiniteScroll(
        messageListRef,
        () => {
            void loadMore()
        },
        view === 'messages' &&
            Boolean(selectedJid) &&
            Boolean(nextCursor) &&
            !loadingMore &&
            !messagesLoading
    )

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
                    <ConnectionStatus
                        state={connectionState}
                        events={connectionEvents}
                        live={connectionState === 'connected' && livePulse}
                        unreachable={linkDown}
                    />
                </div>
            </header>

            <section className="filter-bar" aria-label="Date filters">
                <div className="date-cluster">
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
                    <div className="presets" aria-label="Date presets">
                        {[1, 2, 7, 30].map((days) => (
                            <button
                                className={from === addDays(today, -(days - 1)) && to === today ? 'active' : ''}
                                key={days}
                                onClick={() => applyPreset(days)}
                            >
                                {days === 1 ? (
                                    <>
                                        <span className="preset-long">Today</span>
                                        <span className="preset-short">1d</span>
                                    </>
                                ) : (
                                    <>
                                        <span className="preset-long">{days} days</span>
                                        <span className="preset-short">{days}d</span>
                                    </>
                                )}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="view-switch" aria-label="Dashboard view">
                    <button
                        type="button"
                        className={view === 'messages' ? 'active' : ''}
                        aria-label="Messages"
                        aria-pressed={view === 'messages'}
                        title="Messages"
                        onClick={() => setView('messages')}
                    >
                        <Icon name="message" />
                        <span className="view-switch-label">Chat</span>
                    </button>
                    <button
                        type="button"
                        className={view === 'album' ? 'active' : ''}
                        aria-label="Media"
                        aria-pressed={view === 'album'}
                        title="Media"
                        onClick={() => setView('album')}
                    >
                        <Icon name="image" />
                        <span className="view-switch-label">Media</span>
                    </button>
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
                <div
                    className={`view-pane messages-pane ${view === 'messages' ? 'is-active' : ''}`}
                    aria-hidden={view !== 'messages'}
                >
                    <aside className="groups-panel">
                    <div className="panel-heading">
                        <div>
                            <h2>Groups</h2>
                        </div>
                        <div className="panel-heading-actions">
                            <button
                                type="button"
                                className={`empty-groups-toggle ${showEmptyGroups ? 'active' : ''}`}
                                aria-pressed={showEmptyGroups}
                                title={
                                    showEmptyGroups
                                        ? 'Hide groups with no messages in this range'
                                        : 'Show groups with no messages in this range'
                                }
                                onClick={() => setShowEmptyGroups((current) => !current)}
                            >
                                {showEmptyGroups ? 'Hide empty' : 'Show empty'}
                            </button>
                            <span className="count-pill">{filteredGroups.length}</span>
                        </div>
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
                                    : groups.length === 0
                                      ? 'No groups match the configured name pattern.'
                                      : 'No groups have messages in this date range.'}
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
                                        <div className="load-sentinel" ref={olderSentinelRef}>
                                            {loadingMore ? 'Loading…' : ''}
                                        </div>
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
                <div
                    className={`view-pane media-pane ${view === 'album' ? 'is-active' : ''}`}
                    aria-hidden={view !== 'album'}
                >
                    <AlbumView
                        from={from}
                        to={to}
                        groups={rangedGroups}
                        selectedJid={selectedJid}
                        selectedJids={albumGroupJids}
                        onSelectedJidsChange={setAlbumGroupJids}
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
