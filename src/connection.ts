import { recordDisconnect, setConnectionUp } from './observe.js'

const MAX_EVENTS = 80

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

export type ConnectionEventType = 'disconnected' | 'reconnected'

export type ConnectionEvent = {
    type: ConnectionEventType
    at: number
    detail?: string
}

export type ConnectionStatus = {
    state: ConnectionState
    since: number
    events: ConnectionEvent[]
}

let state: ConnectionState = 'connecting'
let since = Date.now()
let everConnected = false
const events: ConnectionEvent[] = []

function pushEvent(type: ConnectionEventType, detail?: string): void {
    const last = events[0]
    const trimmed = detail?.trim()
    if (last && last.type === type && last.detail === trimmed && Date.now() - last.at < 1500) {
        return
    }
    events.unshift({ type, at: Date.now(), ...(trimmed ? { detail: trimmed } : {}) })
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS
}

function setState(next: ConnectionState): void {
    if (state === next) return
    state = next
    since = Date.now()
}

export function noteConnecting(): void {
    setState('connecting')
    setConnectionUp(false)
}

export function noteDisconnected(detail?: string): void {
    setState('disconnected')
    setConnectionUp(false)
    recordDisconnect(detail?.trim() || 'Connection closed')
    pushEvent('disconnected', detail)
}

export function noteConnected(): void {
    const wasDown = everConnected && state !== 'connected'
    setState('connected')
    setConnectionUp(true)
    if (wasDown) pushEvent('reconnected')
    everConnected = true
}

export function getConnectionStatus(): ConnectionStatus {
    return {
        state,
        since,
        events: events.map((event) => ({ ...event })),
    }
}
