import { useEffect, useMemo, useState } from 'react'

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
}

type GroupsResponse = {
    groups: Group[]
}

type MessagesResponse = {
    messages: Message[]
    nextCursor: string | null
}

const hkDateTime = new Intl.DateTimeFormat('en-HK', {
    timeZone: 'Asia/Hong_Kong',
    dateStyle: 'medium',
    timeStyle: 'short',
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
    return (
        name
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase())
            .join('') || '?'
    )
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
    const [from, setFrom] = useState(initialParams.get('from') || addDays(today, -6))
    const [to, setTo] = useState(initialParams.get('to') || today)
    const [selectedJid, setSelectedJid] = useState<string | null>(initialParams.get('group'))
    const [search, setSearch] = useState('')
    const [groups, setGroups] = useState<Group[]>([])
    const [messages, setMessages] = useState<Message[]>([])
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [groupsLoading, setGroupsLoading] = useState(true)
    const [messagesLoading, setMessagesLoading] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [reloadKey, setReloadKey] = useState(0)

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
            activeGroups: groups.filter((group) => group.tracked).length,
        }),
        [groups]
    )

    useEffect(() => {
        const params = new URLSearchParams()
        params.set('from', from)
        params.set('to', to)
        if (selectedJid) params.set('group', selectedJid)
        window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
    }, [from, to, selectedJid])

    useEffect(() => {
        if (invalidRange) return
        const controller = new AbortController()
        setGroupsLoading(true)
        setError(null)
        getJson<GroupsResponse>(
            `/api/groups?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
            controller.signal
        )
            .then((data) => {
                setGroups(data.groups)
                setSelectedJid((current) => {
                    if (current && data.groups.some((group) => group.jid === current)) return current
                    return data.groups.find((group) => group.messageCount > 0)?.jid || data.groups[0]?.jid || null
                })
            })
            .catch((reason: unknown) => {
                if ((reason as Error).name !== 'AbortError') {
                    setError(reason instanceof Error ? reason.message : 'Could not load groups')
                }
            })
            .finally(() => setGroupsLoading(false))
        return () => controller.abort()
    }, [from, to, invalidRange, reloadKey])

    useEffect(() => {
        if (!selectedJid || invalidRange) {
            setMessages([])
            setNextCursor(null)
            return
        }
        const controller = new AbortController()
        setMessagesLoading(true)
        setError(null)
        getJson<MessagesResponse>(
            `/api/groups/${encodeURIComponent(selectedJid)}/messages?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
            controller.signal
        )
            .then((data) => {
                setMessages(data.messages)
                setNextCursor(data.nextCursor)
            })
            .catch((reason: unknown) => {
                if ((reason as Error).name !== 'AbortError') {
                    setError(reason instanceof Error ? reason.message : 'Could not load messages')
                }
            })
            .finally(() => setMessagesLoading(false))
        return () => controller.abort()
    }, [selectedJid, from, to, invalidRange, reloadKey])

    async function loadMore() {
        if (!selectedJid || !nextCursor || loadingMore) return
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
                    <span className="status-dot" />
                    Live archive
                </div>
            </header>

            <section className="hero">
                <div>
                    <p className="eyebrow">CONVERSATION INTELLIGENCE</p>
                    <h1>Messages, clearly organized.</h1>
                    <p className="hero-copy">
                        Browse your tracked communities, review shared media, and find the moments that matter.
                    </p>
                </div>
                <div className="summary-cards">
                    <div className="summary-card">
                        <span className="summary-icon"><Icon name="message" /></span>
                        <span><strong>{totals.messages.toLocaleString()}</strong><small>Messages in range</small></span>
                    </div>
                    <div className="summary-card">
                        <span className="summary-icon"><Icon name="users" /></span>
                        <span><strong>{totals.activeGroups}</strong><small>Active groups</small></span>
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
                <div className="presets" aria-label="Date presets">
                    {[1, 7, 30].map((days) => (
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

            <main className="dashboard">
                <aside className="groups-panel">
                    <div className="panel-heading">
                        <div>
                            <p className="eyebrow">GROUPS</p>
                            <h2>Conversations</h2>
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

                    <div className="group-list">
                        {groupsLoading &&
                            [1, 2, 3].map((item) => <div className="group-item skeleton-group skeleton" key={item} />)}
                        {!groupsLoading &&
                            filteredGroups.map((group) => (
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
                            <div className="empty-small">No groups match your search.</div>
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

                            {messagesLoading ? (
                                <SkeletonMessages />
                            ) : messages.length ? (
                                <div className="message-list">
                                    {messages.map((message) => (
                                        <article className={`message-card ${message.isDeleted ? 'deleted' : ''}`} key={message.messageId}>
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
                                                    <span>{message.messageType.replace(/Message$/, '')}</span>
                                                </div>
                                                {message.quotedMessage && (
                                                    <blockquote>{message.quotedMessage}</blockquote>
                                                )}
                                                <p className={message.isDeleted ? 'deleted-copy' : ''}>
                                                    {message.isDeleted
                                                        ? 'This message was deleted.'
                                                        : message.textContent || (message.hasMedia ? null : 'No text content')}
                                                </p>
                                                {!message.isDeleted && <MediaPreview message={message} />}
                                            </div>
                                        </article>
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
                            <h3>Select a conversation</h3>
                            <p>Choose a group to explore its archived messages and media.</p>
                        </div>
                    )}
                </section>
            </main>
            <footer>
                Times shown in Hong Kong time · Read-only archive
            </footer>
        </div>
    )
}
