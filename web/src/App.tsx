import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import AlbumView, {
    allMediaCategories,
    emptyCounts,
    isAllTypes,
    type AlbumScope,
    type MediaCategory,
} from './AlbumView'
import DailySiteReportView from './DailySiteReportView'
import DateRangePicker from './DateRangePicker'
import Drawer from './Drawer'
import FilenameSettings from './FilenameSettings'
import FilterSheet from './FilterSheet'
import InstallApp from './InstallApp'
import {
    mergeFirstPage,
    useInfiniteScroll,
    usePinnedScroll,
    useVisibleInterval,
    type SortOrder,
} from './useVisibleInterval'

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
    quotedMessageType: string | null
    quotedMediaId: string | null
    quotedMediaType: string | null
    quotedFileName: string | null
    timestamp: number
    isEdited: boolean
    isDeleted: boolean
    isHistory: boolean
    isForwarded: boolean
    hasMedia: boolean
    fileName: string | null
    reactions: Reaction[]
    albumItems?: Message[]
    siteReportExtracted: boolean
    siteReportFailed: boolean
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

function initialSortOrder(params: URLSearchParams): SortOrder {
    return params.get('order') === 'asc' ? 'asc' : 'desc'
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

function Icon({
    name,
}: {
    name:
        | 'archive'
        | 'search'
        | 'users'
        | 'message'
        | 'image'
        | 'settings'
        | 'sortAsc'
        | 'sortDesc'
        | 'menu'
        | 'filter'
        | 'more'
        | 'report'
}) {
    const paths = {
        archive: (
            <>
                <path d="M4 7.5h16v12H4z" />
                <path d="M3 4.5h18v3H3zM9 11h6" />
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
        settings: (
            <>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z" />
            </>
        ),
        sortAsc: (
            <>
                <path d="M4 7h9M4 12h6M4 17h3" />
                <path d="M18 18V6m0 0-3 3m3-3 3 3" />
            </>
        ),
        sortDesc: (
            <>
                <path d="M4 7h3M4 12h6M4 17h9" />
                <path d="M18 6v12m0 0-3-3m3 3 3-3" />
            </>
        ),
        menu: <path d="M4 7h16M4 12h16M4 17h16" />,
        filter: <path d="M4 5h16l-6.2 7.6V19l-3.6 2v-8.4L4 5z" />,
        more: (
            <>
                <circle cx="6" cy="12" r="1.3" />
                <circle cx="12" cy="12" r="1.3" />
                <circle cx="18" cy="12" r="1.3" />
            </>
        ),
        report: (
            <>
                <path d="M7 4h10v16H7z" />
                <path d="M9 8h6M9 12h6M9 16h4" />
            </>
        ),
    }

    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            {paths[name]}
        </svg>
    )
}

function quotedTypeLabel(type: string | null | undefined): string | null {
    switch (type) {
        case 'imageMessage':
            return 'Photo'
        case 'videoMessage':
        case 'ptvMessage':
            return 'Video'
        case 'stickerMessage':
            return 'Sticker'
        case 'audioMessage':
            return 'Audio'
        case 'documentMessage':
            return 'Document'
        case 'albumMessage':
            return 'Album'
        case 'contactMessage':
        case 'contactsArrayMessage':
            return 'Contact'
        case 'locationMessage':
            return 'Location'
        case 'liveLocationMessage':
            return 'Live location'
        default:
            return null
    }
}

function isVisualQuotedMedia(type: string | null | undefined): boolean {
    return type === 'imageMessage' || type === 'videoMessage' || type === 'ptvMessage' || type === 'stickerMessage'
}

function QuotePreview({ message }: { message: Message }) {
    const kind = quotedTypeLabel(message.quotedMessageType)
    const text = message.quotedMessage
    const thumbType = message.quotedMediaType || message.quotedMessageType
    const thumbUrl = message.quotedMediaId ? mediaUrl(message.quotedMediaId) : null
    const showThumb = Boolean(thumbUrl && isVisualQuotedMedia(thumbType))
    const documentName =
        kind === 'Document' && !text ? message.quotedFileName : null
    if (!text && !kind && !showThumb && !documentName) return null
    if (!kind && !showThumb && !documentName) {
        return <blockquote>{text}</blockquote>
    }

    return (
        <blockquote className="quoted-preview">
            {showThumb && thumbUrl && (
                <a className="quoted-thumb" href={thumbUrl} target="_blank" rel="nofollow noreferrer noopener">
                    {thumbType === 'videoMessage' || thumbType === 'ptvMessage' ? (
                        <video src={`${thumbUrl}#t=0.001`} muted playsInline preload="metadata" />
                    ) : (
                        <img src={thumbUrl} alt="" />
                    )}
                </a>
            )}
            <span className="quoted-copy">
                {kind && <span className="quoted-kind">{kind}</span>}
                {(text || documentName) && (
                    <span className="quoted-text">{text || documentName}</span>
                )}
            </span>
        </blockquote>
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
                aria-label={label}
                aria-expanded={open}
                aria-haspopup="dialog"
                title="Connection log"
                onClick={() => setOpen((current) => !current)}
            >
                <span className={`status-dot is-${state}${live ? ' is-live' : ''}`} />
                <span className="connection-label">{label}</span>
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

function isAlbumVideo(item: { messageType: string }): boolean {
    return item.messageType === 'videoMessage' || item.messageType === 'ptvMessage'
}

function isPdfFile(item: { fileName: string | null }): boolean {
    return fileExtensionLabel(item.fileName, '').toLowerCase() === 'pdf'
}

function mediaUrl(messageId: string): string {
    return `/api/media/${encodeURIComponent(messageId)}`
}

function useMediaReady(src: string) {
    const [readySrc, setReadySrc] = useState<string | null>(null)
    const markReady = useCallback(() => setReadySrc(src), [src])
    const bind = useCallback(
        (element: HTMLImageElement | HTMLVideoElement | null) => {
            if (!element) return
            if (element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0) {
                markReady()
                return
            }
            if (element instanceof HTMLVideoElement && element.readyState >= 2) {
                markReady()
            }
        },
        [markReady]
    )

    return {
        ready: readySrc === src,
        bind,
        onReady: markReady,
    }
}

function MediaPlaceholder() {
    return <span className="media-placeholder skeleton" aria-hidden="true" />
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

function LightboxStage({ item }: { item: Message }) {
    const url = mediaUrl(item.messageId)
    if (isAlbumVideo(item)) {
        return (
            <video
                key={item.messageId}
                src={url}
                controls
                playsInline
                preload="auto"
            />
        )
    }
    if (item.messageType === 'imageMessage' || item.messageType === 'stickerMessage') {
        return (
            <img
                key={item.messageId}
                src={url}
                alt={item.textContent || 'Shared media'}
            />
        )
    }
    if (item.messageType === 'audioMessage') {
        return (
            <div className="lightbox-file audio">
                <span className="file-glyph">♪</span>
                <strong>{item.fileName || 'Audio message'}</strong>
                <audio key={item.messageId} src={url} controls preload="auto" />
            </div>
        )
    }
    if (isPdfFile(item)) {
        return (
            <iframe
                key={item.messageId}
                className="lightbox-pdf"
                title={item.fileName || 'PDF document'}
                src={url}
            />
        )
    }
    return (
        <div className="lightbox-file">
            <span className="file-glyph">{fileExtensionLabel(item.fileName, 'FILE')}</span>
            <strong>{item.fileName || 'Shared document'}</strong>
            <p>This file can't be previewed here.</p>
            <a
                href={url}
                target="_blank"
                rel="nofollow noreferrer noopener"
                download={item.fileName || undefined}
                className="download-button"
            >
                <DownloadIcon />
                Download
            </a>
        </div>
    )
}

function MediaLightbox({
    items,
    index,
    onClose,
    onIndexChange,
    heading,
}: {
    items: Message[]
    index: number
    onClose: () => void
    onIndexChange: (index: number) => void
    heading?: string
}) {
    const item = items[index]

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
            if (items.length < 2) return
            if (event.key === 'ArrowRight') onIndexChange((index + 1) % items.length)
            if (event.key === 'ArrowLeft') {
                onIndexChange((index - 1 + items.length) % items.length)
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [index, items.length, onClose, onIndexChange])

    const swipe = useRef<{ x: number; y: number } | null>(null)

    if (!item) return null
    const url = mediaUrl(item.messageId)

    function step(delta: number) {
        if (items.length < 2) return
        onIndexChange((index + delta + items.length) % items.length)
    }

    return createPortal(
        <div
            className={`lightbox${items.length > 1 ? ' has-nav' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label="Media preview"
            onClick={onClose}
        >
            <button
                className="lightbox-close"
                onClick={(event) => {
                    event.stopPropagation()
                    onClose()
                }}
                type="button"
                aria-label="Close"
            >
                ×
            </button>
            <div
                className="lightbox-media"
                onClick={(event) => event.stopPropagation()}
                onTouchStart={(event) => {
                    swipe.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }
                }}
                onTouchEnd={(event) => {
                    if (!swipe.current || items.length < 2) return
                    const dx = event.changedTouches[0].clientX - swipe.current.x
                    const dy = event.changedTouches[0].clientY - swipe.current.y
                    swipe.current = null
                    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.4) return
                    step(dx < 0 ? 1 : -1)
                }}
            >
                {items.length > 1 && (
                    <>
                        <button
                            className="lightbox-nav prev"
                            type="button"
                            aria-label="Previous"
                            onClick={(event) => {
                                event.stopPropagation()
                                step(-1)
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
                                step(1)
                            }}
                        >
                            ›
                        </button>
                    </>
                )}
                <div className={`lightbox-stage${isPdfFile(item) ? ' is-embed' : ''}`}>
                    <LightboxStage item={item} />
                </div>
            </div>
            <div className="lightbox-info" onClick={(event) => event.stopPropagation()}>
                <strong>{heading || item.senderName || 'Media'}</strong>
                {heading && item.senderName && (
                    <span className="lightbox-meta">{item.senderName}</span>
                )}
                <time className="lightbox-meta">{hkDateTime.format(item.timestamp * 1000)}</time>
                {items.length > 1 && (
                    <span className="lightbox-meta">
                        {index + 1} of {items.length}
                    </span>
                )}
                {item.textContent && <p className="lightbox-copy">{item.textContent}</p>}
                {item.fileName && <span className="lightbox-meta">{item.fileName}</span>}
                <a
                    href={url}
                    target="_blank"
                    rel="nofollow noreferrer noopener"
                    download={item.fileName || undefined}
                    className="download-button"
                >
                    <DownloadIcon />
                    Download
                </a>
            </div>
        </div>,
        document.body
    )
}

function MessageMediaButton({
    url,
    kind,
    alt,
    label,
    onOpen,
}: {
    url: string
    kind: 'image' | 'video'
    alt: string
    label: string
    onOpen: () => void
}) {
    const src = kind === 'video' ? `${url}#t=0.001` : url
    const { ready, bind, onReady } = useMediaReady(src)

    return (
        <button
            type="button"
            className={`media-frame${kind === 'video' ? ' is-video' : ''}${ready ? ' is-ready' : ' is-loading'}`}
            onClick={onOpen}
            aria-label={label}
        >
            {!ready && <MediaPlaceholder />}
            {kind === 'video' ? (
                <video
                    ref={bind}
                    src={src}
                    muted
                    playsInline
                    preload="metadata"
                    onLoadedData={onReady}
                />
            ) : (
                <img ref={bind} src={src} alt={alt} loading="lazy" onLoad={onReady} />
            )}
            {kind === 'video' && ready && (
                <span className="conversation-album-play" aria-hidden="true">
                    ▶
                </span>
            )}
        </button>
    )
}

function MediaPreview({ message }: { message: Message }) {
    const [open, setOpen] = useState(false)
    if (!message.hasMedia) return null
    const url = mediaUrl(message.messageId)
    const type = message.messageType

    if (type === 'imageMessage' || type === 'stickerMessage') {
        return (
            <>
                <MessageMediaButton
                    url={url}
                    kind="image"
                    alt={message.textContent || 'Shared media'}
                    label="Open photo"
                    onOpen={() => setOpen(true)}
                />
                {open && (
                    <MediaLightbox
                        items={[message]}
                        index={0}
                        onClose={() => setOpen(false)}
                        onIndexChange={() => {}}
                    />
                )}
            </>
        )
    }
    if (isAlbumVideo(message)) {
        return (
            <>
                <MessageMediaButton
                    url={url}
                    kind="video"
                    alt={message.textContent || 'Shared video'}
                    label="Open video"
                    onOpen={() => setOpen(true)}
                />
                {open && (
                    <MediaLightbox
                        items={[message]}
                        index={0}
                        onClose={() => setOpen(false)}
                        onIndexChange={() => {}}
                    />
                )}
            </>
        )
    }
    if (type === 'audioMessage') {
        return <audio className="audio-player" src={url} controls preload="metadata" />
    }
    return (
        <>
            <button
                type="button"
                className="document-link"
                onClick={() => setOpen(true)}
                aria-label={isPdfFile(message) ? 'Open PDF' : 'Open document'}
            >
                <span className="document-icon">{fileExtensionLabel(message.fileName, 'FILE')}</span>
                <span>
                    <strong>{message.fileName || 'Open document'}</strong>
                    <small>Shared attachment</small>
                </span>
            </button>
            {open && (
                <MediaLightbox
                    items={[message]}
                    index={0}
                    onClose={() => setOpen(false)}
                    onIndexChange={() => {}}
                />
            )}
        </>
    )
}

function albumSummary(items: Message[]): string {
    const photos = items.filter((item) => !isAlbumVideo(item)).length
    const videos = items.filter(isAlbumVideo).length
    const parts = []
    if (photos) parts.push(`${photos} photo${photos === 1 ? '' : 's'}`)
    if (videos) parts.push(`${videos} video${videos === 1 ? '' : 's'}`)
    return parts.join(' · ') || 'Album'
}

function ConversationAlbumTile({
    item,
    showMore,
    onOpen,
}: {
    item: Message
    showMore: number
    onOpen: () => void
}) {
    const isVideo = isAlbumVideo(item)
    const src = isVideo ? `${mediaUrl(item.messageId)}#t=0.001` : mediaUrl(item.messageId)
    const { ready, bind, onReady } = useMediaReady(src)

    return (
        <button
            className={`conversation-album-tile${isVideo ? ' video' : ''}${ready ? ' is-ready' : ' is-loading'}`}
            type="button"
            onClick={onOpen}
            aria-label={
                showMore
                    ? `Open album, ${showMore} more`
                    : isVideo
                      ? 'Open video'
                      : 'Open photo'
            }
        >
            {!ready && <MediaPlaceholder />}
            {isVideo ? (
                <video ref={bind} src={src} preload="metadata" muted playsInline onLoadedData={onReady} />
            ) : (
                <img
                    ref={bind}
                    src={src}
                    alt={item.textContent || 'Album photo'}
                    loading="lazy"
                    onLoad={onReady}
                />
            )}
            {isVideo && !showMore && ready && (
                <span className="conversation-album-play" aria-hidden="true">
                    ▶
                </span>
            )}
            {showMore > 0 && (
                <span className="conversation-album-more">+{showMore}</span>
            )}
        </button>
    )
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
    const extra = visible.length > 4 ? visible.length - 3 : 0
    const [openIndex, setOpenIndex] = useState<number | null>(null)

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
                    const showMore = extra > 0 && index === preview.length - 1
                    return (
                        <ConversationAlbumTile
                            key={item.messageId}
                            item={item}
                            showMore={showMore ? extra : 0}
                            onOpen={() => setOpenIndex(index)}
                        />
                    )
                })}
            </div>
            {openIndex !== null && visible[openIndex] && (
                <MediaLightbox
                    items={visible}
                    index={openIndex}
                    heading={albumSummary(visible)}
                    onClose={() => setOpenIndex(null)}
                    onIndexChange={setOpenIndex}
                />
            )}
        </>
    )
}

function hasStoredContent(message: Message): boolean {
    if (message.textContent || message.hasMedia || message.quotedMessage) return true
    if (message.quotedMessageType || message.quotedMediaId) return true
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
                                    <a href={`tel:${card.detail.replace(/[^\d+]/g, '')}`} rel="nofollow">{card.detail}</a>
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
            <a className="share-card" href={place.mapsUrl} target="_blank" rel="nofollow noreferrer noopener">
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

function MessageCard({
    message,
    onOpenReports,
}: {
    message: Message
    onOpenReports?: () => void
}) {
    const [revealed, setRevealed] = useState(false)
    const canReveal = message.isDeleted && hasStoredContent(message)
    const showSiteReportBadge =
        (!message.isDeleted || revealed) &&
        (message.siteReportExtracted || message.siteReportFailed)

    return (
        <article className={`message-card ${message.isDeleted ? 'deleted' : ''} ${revealed ? 'revealed' : ''}`}>
            <span className="sender-avatar">
                {initials(message.senderName || message.senderJid || 'Unknown')}
            </span>
            <div className="message-content">
                <header>
                    <span className="message-byline">
                        <strong>{message.senderName || message.senderJid || 'Unknown sender'}</strong>
                        {message.isForwarded && (!message.isDeleted || revealed) && (
                            <span className="forwarded-label">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M4 15.5C4 11.4 7.4 8 11.5 8H19" />
                                    <path d="m15.5 4.5 5 3.5-5 3.5" />
                                </svg>
                                Forwarded
                            </span>
                        )}
                        {showSiteReportBadge && (
                            <button
                                type="button"
                                className={`site-report-label${message.siteReportFailed ? ' is-failed' : ''}`}
                                title={
                                    message.siteReportExtracted
                                        ? 'Daily site report extracted — open Reports'
                                        : 'Site report workflow failed'
                                }
                                onClick={() => onOpenReports?.()}
                            >
                                {message.siteReportExtracted ? (
                                    <>
                                        <svg viewBox="0 0 24 24" aria-hidden="true">
                                            <path d="M7 4h10v16H7z" />
                                            <path d="M9 8h6M9 12h4" />
                                        </svg>
                                        工地報告
                                    </>
                                ) : (
                                    '分析失敗'
                                )}
                            </button>
                        )}
                    </span>
                    <time>{hkDateTime.format(message.timestamp * 1000)}</time>
                </header>
                {(!message.isDeleted || revealed) && <QuotePreview message={message} />}
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
    const [from, setFrom] = useState(initialParams.get('from') || today)
    const [to, setTo] = useState(initialParams.get('to') || today)
    const [selectedJid, setSelectedJid] = useState<string | null>(initialParams.get('group'))
    const [view, setView] = useState<'messages' | 'album' | 'reports'>(
        initialParams.get('view') === 'album'
            ? 'album'
            : initialParams.get('view') === 'reports'
              ? 'reports'
              : 'messages'
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
    const [albumQuery, setAlbumQuery] = useState(initialParams.get('q') || '')
    const [reportsQuery, setReportsQuery] = useState(initialParams.get('rq') || '')
    const [reportsDateField, setReportsDateField] = useState<'report' | 'created'>(
        initialParams.get('dateField') === 'created' ? 'created' : 'report'
    )
    const [reportsGroupsCollapsed, setReportsGroupsCollapsed] = useState(
        () =>
            typeof localStorage !== 'undefined' &&
            localStorage.getItem('reportsGroupsCollapsed') === '1'
    )
    const [sortOrder, setSortOrder] = useState<SortOrder>(initialSortOrder(initialParams))
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
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const [filterOpen, setFilterOpen] = useState(false)
    const [overflowOpen, setOverflowOpen] = useState(false)
    const [albumCounts, setAlbumCounts] = useState(emptyCounts)
    const overflowRef = useRef<HTMLDivElement>(null)
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
    const displayMessages = useMemo(
        () => (sortOrder === 'asc' ? [...messages].reverse() : messages),
        [messages, sortOrder]
    )
    const dateIsDefault = from === today && to === today
    const typesAreDefault = isAllTypes(albumTypes)
    const activeFilterCount = [
        !dateIsDefault,
        sortOrder === 'asc',
        view === 'album' && !typesAreDefault,
        view === 'album' && albumScope === 'group',
    ].filter(Boolean).length
    const headerTitle =
        view === 'album'
            ? albumScope === 'group' && albumGroupJids.length
                ? albumGroupJids
                      .map((jid) => groups.find((group) => group.jid === jid)?.name)
                      .filter(Boolean)
                      .join(' · ') || 'Selected groups'
                : 'All media'
            : view === 'reports'
              ? selectedGroup?.name || 'Site reports'
              : selectedGroup?.name || 'Groups'
    const messageScrollKey = `${selectedJid ?? ''}|${from}|${to}|${reloadKey}`
    const { onScroll: onMessageListScroll } = usePinnedScroll(
        messageListRef,
        messages,
        sortOrder,
        messageScrollKey,
        scrollRestore
    )

    useEffect(() => {
        const params = new URLSearchParams()
        params.set('from', from)
        params.set('to', to)
        params.set('view', view)
        params.set('order', sortOrder)
        if (showEmptyGroups) params.set('empty', '1')
        if (selectedJid) params.set('group', selectedJid)
        if (view === 'album') {
            params.set('scope', albumScope)
            params.set('types', albumTypes.join(','))
            if (albumScope === 'group' && albumGroupJids.length) {
                params.set('groups', albumGroupJids.join(','))
            }
            if (albumQuery.trim()) params.set('q', albumQuery.trim())
        }
        if (view === 'reports') {
            if (reportsQuery.trim()) params.set('rq', reportsQuery.trim())
            if (reportsDateField === 'created') params.set('dateField', 'created')
        }
        window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
    }, [from, to, selectedJid, view, albumScope, albumGroupJids, albumTypes, albumQuery, reportsQuery, reportsDateField, showEmptyGroups, sortOrder])

    useEffect(() => {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem('reportsGroupsCollapsed', reportsGroupsCollapsed ? '1' : '0')
    }, [reportsGroupsCollapsed])

    useEffect(() => {
        if (groupsLoading || view === 'reports') return
        if (selectedJid && rangedGroups.some((group) => group.jid === selectedJid)) return
        setSelectedJid(rangedGroups[0]?.jid ?? null)
    }, [groupsLoading, rangedGroups, selectedJid, view])

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

    useEffect(() => {
        const media = window.matchMedia('(min-width: 960px)')
        const onChange = () => {
            if (!media.matches) return
            setDrawerOpen(false)
            setFilterOpen(false)
            setOverflowOpen(false)
        }
        media.addEventListener('change', onChange)
        return () => media.removeEventListener('change', onChange)
    }, [])

    useEffect(() => {
        if (!overflowOpen) return undefined
        const onPointer = (event: MouseEvent) => {
            if (!overflowRef.current?.contains(event.target as Node)) setOverflowOpen(false)
        }
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOverflowOpen(false)
        }
        window.addEventListener('mousedown', onPointer)
        window.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('mousedown', onPointer)
            window.removeEventListener('keydown', onKey)
        }
    }, [overflowOpen])


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
                    if (view === 'reports') return current
                    return (
                        data.groups.find((group) => group.messageCount > 0)?.jid ||
                        data.groups[0]?.jid ||
                        null
                    )
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
    }, [from, to, invalidRange, reloadKey, view])

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
                if (currentView === 'reports') return current
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
                if (sortOrder === 'desc' && list && list.scrollTop > 40) {
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
            !messagesLoading,
        sortOrder
    )

    async function loadMore() {
        if (!selectedJid || !nextCursor || loadingMore) return
        silentGen.current += 1
        setLoadingMore(true)
        const list = messageListRef.current
        if (sortOrder === 'asc' && list) {
            scrollRestore.current = { top: list.scrollTop, height: list.scrollHeight }
        }
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

    function dateChipLabel(): string {
        if (from === to) return from === today ? 'Today' : from
        const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1
        if (to === today && days === 2) return '2d'
        if (to === today && days === 7) return '7d'
        if (to === today && days === 30) return '30d'
        return `${from} – ${to}`
    }

    function pickGroup(jid: string) {
        if (view === 'album') {
            if (albumScope === 'all') {
                setAlbumScope('group')
                setAlbumGroupJids([jid])
                setDrawerOpen(false)
                return
            }
            setAlbumGroupJids((current) =>
                current.includes(jid) ? current.filter((item) => item !== jid) : [...current, jid]
            )
            return
        }
        setSelectedJid(jid)
        setDrawerOpen(false)
    }

    function renderGroupsPanel(inDrawer = false) {
        const multi = view === 'album' && albumScope === 'group'
        return (
            <>
                {view === 'reports' && (
                    <>
                        {!inDrawer ? (
                            <div className="groups-panel-top desktop-only">
                                <button
                                    type="button"
                                    className={`all-groups-card ${!selectedJid ? 'selected' : ''}`}
                                    onClick={() => {
                                        setSelectedJid(null)
                                        setDrawerOpen(false)
                                    }}
                                >
                                    <span className="all-groups-card-icon" aria-hidden="true">
                                        <svg viewBox="0 0 24 24">
                                            <path d="M12 3 3 8v8l9 5 9-5V8l-9-5Z" />
                                            <path d="M12 12 3 7" />
                                            <path d="m12 12 9-5" />
                                            <path d="M12 12v9" />
                                        </svg>
                                    </span>
                                    <span className="all-groups-card-copy">
                                        <strong>All groups</strong>
                                        <span>Every extracted report in range</span>
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    className="groups-panel-toggle groups-panel-toggle--collapse"
                                    onClick={() => setReportsGroupsCollapsed(true)}
                                    title="Hide groups"
                                    aria-label="Hide groups"
                                >
                                    <svg viewBox="0 0 24 24" aria-hidden="true">
                                        <path d="m15 6-6 6 6 6" />
                                    </svg>
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className={`all-groups-card ${!selectedJid ? 'selected' : ''}`}
                                onClick={() => {
                                    setSelectedJid(null)
                                    setDrawerOpen(false)
                                }}
                            >
                                <span className="all-groups-card-icon" aria-hidden="true">
                                    <svg viewBox="0 0 24 24">
                                        <path d="M12 3 3 8v8l9 5 9-5V8l-9-5Z" />
                                        <path d="M12 12 3 7" />
                                        <path d="m12 12 9-5" />
                                        <path d="M12 12v9" />
                                    </svg>
                                </span>
                                <span className="all-groups-card-copy">
                                    <strong>All groups</strong>
                                    <span>Every extracted report in range</span>
                                </span>
                            </button>
                        )}
                    </>
                )}
                {view === 'album' && (
                    <div className="scope-switch" role="group" aria-label="Album scope">
                        <button
                            type="button"
                            className={albumScope === 'all' ? 'active' : ''}
                            onClick={() => setAlbumScope('all')}
                        >
                            All groups
                        </button>
                        <button
                            type="button"
                            className={albumScope === 'group' ? 'active' : ''}
                            onClick={() => {
                                setAlbumScope('group')
                                if (albumGroupJids.length === 0 && selectedJid) {
                                    setAlbumGroupJids([selectedJid])
                                }
                            }}
                        >
                            Selected
                        </button>
                    </div>
                )}
                <div className={`panel-heading${inDrawer ? ' is-drawer' : ''}`}>
                    {inDrawer ? null : (
                        <div className="panel-heading-title">
                            <h2>Groups</h2>
                        </div>
                    )}
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
                            Loading
                        </div>
                    )}
                    {groupsLoading &&
                        groups.length === 0 &&
                        [1, 2, 3].map((item) => <div className="group-item skeleton-group skeleton" key={item} />)}
                    {filteredGroups.map((group) => {
                        const selected =
                            view === 'album'
                                ? multi && albumGroupJids.includes(group.jid)
                                : view === 'reports'
                                  ? group.jid === selectedJid
                                  : group.jid === selectedJid
                        return (
                            <button
                                className={`group-item ${selected ? 'selected' : ''}`}
                                key={group.jid}
                                onClick={() => pickGroup(group.jid)}
                            >
                                <span className="group-avatar">{initials(group.name)}</span>
                                <span className="group-copy">
                                    <span className="group-title-row">
                                        <strong>{group.name}</strong>
                                        {!group.tracked && <span className="inactive-dot" title="Inactive group" />}
                                    </span>
                                    <span className="group-preview">
                                        {group.latestText ||
                                            (group.messageCount ? 'Media message' : 'No messages in range')}
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
                        )
                    })}
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
            </>
        )
    }

    return (
        <div className={`app-shell${view === 'album' ? ' is-album' : ''}${view === 'reports' ? ' is-reports' : ''}`}>
            <header className="topbar">
                <button
                    type="button"
                    className="icon-btn mobile-only"
                    aria-label="Open groups"
                    onClick={() => {
                        setOverflowOpen(false)
                        setDrawerOpen(true)
                    }}
                >
                    <Icon name="menu" />
                </button>
                <div className="brand desktop-only">
                    <span className="brand-mark">
                        <Icon name="archive" />
                    </span>
                    <span>
                        <strong>Group Archive</strong>
                        <small>WhatsApp message dashboard</small>
                    </span>
                </div>
                <button
                    type="button"
                    className="header-title mobile-only"
                    onClick={() => {
                        setOverflowOpen(false)
                        setDrawerOpen(true)
                    }}
                >
                    <strong
                        className={
                            view === 'album' && albumScope === 'group' && albumGroupJids.length > 1
                                ? 'is-multi'
                                : undefined
                        }
                    >
                        {headerTitle}
                    </strong>
                    {view === 'messages' && selectedGroup && (
                        <small>
                            {selectedGroup.messageCount} messages · {selectedGroup.senderCount} senders
                        </small>
                    )}
                </button>
                <div className="topbar-status">
                    {pattern && (
                        <div
                            className="pattern-meta desktop-only"
                            title={`GROUP_PATTERN /${pattern.source}/${pattern.flags}`}
                        >
                            <span>Matching</span>
                            {patternTerms.map((term) => (
                                <code key={term}>{term}</code>
                            ))}
                        </div>
                    )}
                    <div className="desktop-only topbar-desktop-actions">
                        <InstallApp />
                        <div className="segmented-control sort-switch" role="group" aria-label="Sort order">
                            <button
                                type="button"
                                className={sortOrder === 'asc' ? 'active' : ''}
                                aria-pressed={sortOrder === 'asc'}
                                aria-label="Oldest first"
                                title="Oldest first"
                                onClick={() => setSortOrder('asc')}
                            >
                                <Icon name="sortAsc" />
                            </button>
                            <button
                                type="button"
                                className={sortOrder === 'desc' ? 'active' : ''}
                                aria-pressed={sortOrder === 'desc'}
                                aria-label="Newest first"
                                title="Newest first"
                                onClick={() => setSortOrder('desc')}
                            >
                                <Icon name="sortDesc" />
                            </button>
                        </div>
                        <button
                            type="button"
                            className="settings-toggle"
                            aria-label="Filename format settings"
                            title="Filename format"
                            onClick={() => setSettingsOpen(true)}
                        >
                            <Icon name="settings" />
                        </button>
                        <ConnectionStatus
                            state={connectionState}
                            events={connectionEvents}
                            live={connectionState === 'connected' && livePulse}
                            unreachable={linkDown}
                        />
                    </div>
                    <button
                        type="button"
                        className={`icon-btn header-filter mobile-only${activeFilterCount ? ' has-badge' : ''}`}
                        aria-label={activeFilterCount ? `Filters, ${activeFilterCount} active` : 'Filters'}
                        onClick={() => {
                            setOverflowOpen(false)
                            setFilterOpen(true)
                        }}
                    >
                        <Icon name="filter" />
                        {activeFilterCount > 0 && <span className="filter-badge">{activeFilterCount}</span>}
                    </button>
                    <div className="overflow-menu mobile-only" ref={overflowRef}>
                        <button
                            type="button"
                            className="icon-btn"
                            aria-label="More"
                            aria-expanded={overflowOpen}
                            aria-haspopup="menu"
                            onClick={() => setOverflowOpen((current) => !current)}
                        >
                            <Icon name="more" />
                        </button>
                        {overflowOpen && (
                            <div className="overflow-panel" role="menu">
                                <button
                                    type="button"
                                    className="overflow-item"
                                    role="menuitem"
                                    onClick={() => {
                                        setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
                                        setOverflowOpen(false)
                                    }}
                                >
                                    {sortOrder === 'asc' ? 'Newest first' : 'Oldest first'}
                                </button>
                                <button
                                    type="button"
                                    className="overflow-item"
                                    role="menuitem"
                                    onClick={() => {
                                        setOverflowOpen(false)
                                        setSettingsOpen(true)
                                    }}
                                >
                                    Filename settings
                                </button>
                                <InstallApp variant="item" />
                                <ConnectionStatus
                                    state={connectionState}
                                    events={connectionEvents}
                                    live={connectionState === 'connected' && livePulse}
                                    unreachable={linkDown}
                                />
                            </div>
                        )}
                    </div>
                </div>
            </header>

            {activeFilterCount > 0 && (
                <div className="filter-chips mobile-only" aria-label="Active filters">
                    {!dateIsDefault && (
                        <button type="button" className="filter-chip" onClick={() => applyPreset(1)}>
                            {dateChipLabel()}
                            <span aria-hidden="true">×</span>
                        </button>
                    )}
                    {sortOrder === 'asc' && (
                        <button type="button" className="filter-chip" onClick={() => setSortOrder('desc')}>
                            Oldest first
                            <span aria-hidden="true">×</span>
                        </button>
                    )}
                    {view === 'album' && !typesAreDefault &&
                        albumTypes.map((type) => (
                            <button
                                key={type}
                                type="button"
                                className="filter-chip"
                                onClick={() => {
                                    const next = albumTypes.filter((item) => item !== type)
                                    setAlbumTypes(next.length ? next : [...allMediaCategories])
                                }}
                            >
                                {type === 'document' ? 'Docs' : type[0].toUpperCase() + type.slice(1)}
                                <span aria-hidden="true">×</span>
                            </button>
                        ))}
                    {view === 'album' &&
                        albumScope === 'group' &&
                        albumGroupJids.map((jid) => {
                            const name = groups.find((group) => group.jid === jid)?.name || 'Group'
                            return (
                                <button
                                    type="button"
                                    className="filter-chip"
                                    key={jid}
                                    onClick={() => {
                                        const next = albumGroupJids.filter((item) => item !== jid)
                                        setAlbumGroupJids(next)
                                        if (next.length === 0) setAlbumScope('all')
                                    }}
                                >
                                    {name}
                                    <span aria-hidden="true">×</span>
                                </button>
                            )
                        })}
                </div>
            )}

            <section className="filter-bar desktop-only" aria-label="Date filters">
                <div className="date-cluster">
                    <DateRangePicker
                        from={from}
                        to={to}
                        max={today}
                        onChange={(nextFrom, nextTo) => {
                            setFrom(nextFrom)
                            setTo(nextTo)
                        }}
                    />
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
                    <button
                        type="button"
                        className={view === 'reports' ? 'active' : ''}
                        aria-label="Site reports"
                        aria-pressed={view === 'reports'}
                        title="Site reports"
                        onClick={() => setView('reports')}
                    >
                        <Icon name="report" />
                        <span className="view-switch-label">Reports</span>
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
                className={`dashboard ${view === 'album' ? 'album-dashboard' : ''}${view === 'reports' ? ' reports-dashboard' : ''}`}
                aria-busy={groupsLoading || messagesLoading}
            >
                <div
                    className={`view-pane messages-pane ${view === 'messages' ? 'is-active' : ''}`}
                    aria-hidden={view !== 'messages'}
                >
                    <aside className="groups-panel desktop-only">{renderGroupsPanel()}</aside>

                <section className="messages-panel">
                    {selectedGroup ? (
                        <>
                            <header className="messages-heading desktop-only">
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
                                    onScroll={onMessageListScroll}
                                >
                                    {messagesLoading && (
                                        <div className="content-overlay" role="status">
                                            <span className="overlay-spinner" />
                                            Loading
                                        </div>
                                    )}
                                    {sortOrder === 'asc' && nextCursor && (
                                        <div className="load-sentinel is-start" ref={olderSentinelRef}>
                                            {loadingMore ? 'Loading…' : ''}
                                        </div>
                                    )}
                                    {displayMessages.map((message) => (
                                        <MessageCard
                                            message={message}
                                            key={message.messageId}
                                            onOpenReports={() => setView('reports')}
                                        />
                                    ))}
                                    {sortOrder === 'desc' && nextCursor && (
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
                        query={albumQuery}
                        onQueryChange={setAlbumQuery}
                        sortOrder={sortOrder}
                        active={view === 'album'}
                        onLiveUpdate={pulseLive}
                        onCountsChange={setAlbumCounts}
                    />
                </div>
                <div
                    className={`view-pane reports-pane ${view === 'reports' ? 'is-active' : ''}${reportsGroupsCollapsed ? ' groups-collapsed' : ''}`}
                    aria-hidden={view !== 'reports'}
                >
                    <aside
                        className={`groups-panel desktop-only${reportsGroupsCollapsed ? ' is-collapsed' : ''}`}
                    >
                        {renderGroupsPanel()}
                    </aside>
                    <DailySiteReportView
                        from={from}
                        to={to}
                        groupJid={selectedJid}
                        groupName={selectedGroup?.name ?? null}
                        query={reportsQuery}
                        onQueryChange={setReportsQuery}
                        dateField={reportsDateField}
                        onDateFieldChange={setReportsDateField}
                        active={view === 'reports'}
                        onLiveUpdate={pulseLive}
                        groupsCollapsed={reportsGroupsCollapsed}
                        onOpenGroups={() => setReportsGroupsCollapsed(false)}
                    />
                </div>
            </main>
            <nav className="bottom-nav mobile-only" aria-label="Views">
                <button
                    type="button"
                    className={view === 'messages' ? 'active' : ''}
                    aria-pressed={view === 'messages'}
                    onClick={() => setView('messages')}
                >
                    <Icon name="message" />
                    Chat
                </button>
                <button
                    type="button"
                    className={view === 'album' ? 'active' : ''}
                    aria-pressed={view === 'album'}
                    onClick={() => setView('album')}
                >
                    <Icon name="image" />
                    Media
                </button>
                <button
                    type="button"
                    className={view === 'reports' ? 'active' : ''}
                    aria-pressed={view === 'reports'}
                    onClick={() => setView('reports')}
                >
                    <Icon name="report" />
                    Reports
                </button>
            </nav>
            <Drawer
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                title={
                    view === 'album' ? 'Media groups' : view === 'reports' ? 'Report groups' : 'Groups'
                }
            >
                {renderGroupsPanel(true)}
            </Drawer>
            <FilterSheet
                open={filterOpen}
                onClose={() => setFilterOpen(false)}
                from={from}
                to={to}
                today={today}
                onRangeChange={(nextFrom, nextTo) => {
                    setFrom(nextFrom)
                    setTo(nextTo)
                }}
                onPreset={applyPreset}
                sortOrder={sortOrder}
                onSortChange={setSortOrder}
                view={view}
                types={albumTypes}
                onTypesChange={setAlbumTypes}
                counts={albumCounts}
                scope={albumScope}
                selectedGroupNames={albumGroupJids
                    .map((jid) => groups.find((group) => group.jid === jid)?.name)
                    .filter((name): name is string => Boolean(name))}
                onOpenGroups={() => {
                    setFilterOpen(false)
                    if (albumScope !== 'group') {
                        setAlbumScope('group')
                        if (albumGroupJids.length === 0 && selectedJid) {
                            setAlbumGroupJids([selectedJid])
                        }
                    }
                    setDrawerOpen(true)
                }}
            />
            <FilenameSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </div>
    )
}
