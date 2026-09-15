import { redis } from './redis.js'
import { log } from './log.js'

const CONNECTION_KEY = 'whatsapp:connection'
const ALIVE_KEY = 'whatsapp:connection:alive'
export const CONNECTION_CHANNEL = 'whatsapp.connection'
const ALIVE_TTL_SECONDS = 30
const HEARTBEAT_MS = 15_000
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

type StoredStatus = ConnectionStatus & { everConnected?: boolean }

const emptyStatus = (): StoredStatus => ({
    state: 'disconnected',
    since: Date.now(),
    events: [],
    everConnected: false,
})

function parseStatus(raw: string | null): StoredStatus {
    if (!raw) return emptyStatus()
    try {
        const parsed = JSON.parse(raw) as Partial<StoredStatus>
        const state =
            parsed.state === 'connecting' || parsed.state === 'connected' || parsed.state === 'disconnected'
                ? parsed.state
                : 'disconnected'
        return {
            state,
            since: typeof parsed.since === 'number' && Number.isFinite(parsed.since) ? parsed.since : Date.now(),
            events: Array.isArray(parsed.events)
                ? parsed.events.filter(
                      (event): event is ConnectionEvent =>
                          Boolean(
                              event &&
                                  (event.type === 'disconnected' || event.type === 'reconnected') &&
                                  typeof event.at === 'number'
                          )
                  )
                : [],
            everConnected: Boolean(parsed.everConnected),
        }
    } catch {
        return emptyStatus()
    }
}

async function readStored(): Promise<StoredStatus> {
    return parseStatus(await redis.get(CONNECTION_KEY))
}

async function writeStatus(status: StoredStatus): Promise<void> {
    const body = JSON.stringify(status)
    try {
        await redis.set(CONNECTION_KEY, body)
        await redis.publish(CONNECTION_CHANNEL, body)
    } catch (error) {
        log.warn({ err: String(error) }, 'connection_status.write_failed')
    }
}

async function touchAlive(): Promise<void> {
    try {
        await redis.set(ALIVE_KEY, '1', 'EX', ALIVE_TTL_SECONDS)
    } catch (error) {
        log.warn({ err: String(error) }, 'connection_status.alive_failed')
    }
}

function pushEvent(status: StoredStatus, type: ConnectionEventType, detail?: string): void {
    const last = status.events[0]
    const trimmed = detail?.trim()
    if (last && last.type === type && last.detail === trimmed && Date.now() - last.at < 30_000) {
        return
    }
    status.events.unshift({ type, at: Date.now(), ...(trimmed ? { detail: trimmed } : {}) })
    if (status.events.length > MAX_EVENTS) status.events.length = MAX_EVENTS
}

function setState(status: StoredStatus, next: ConnectionState): void {
    if (status.state === next) return
    status.state = next
    status.since = Date.now()
}

export async function noteConnecting(): Promise<void> {
    await touchAlive()
    const status = await readStored()
    setState(status, 'connecting')
    await writeStatus(status)
}

export async function noteDisconnected(detail?: string): Promise<void> {
    await touchAlive()
    const status = await readStored()
    setState(status, 'disconnected')
    pushEvent(status, 'disconnected', detail)
    await writeStatus(status)
}

export async function noteConnected(): Promise<void> {
    await touchAlive()
    const status = await readStored()
    const wasDown = Boolean(status.everConnected && status.state !== 'connected')
    setState(status, 'connected')
    status.everConnected = true
    if (wasDown) pushEvent(status, 'reconnected')
    await writeStatus(status)
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
    const [raw, alive] = await Promise.all([redis.get(CONNECTION_KEY), redis.get(ALIVE_KEY)])
    const status = parseStatus(raw)
    const state = !alive && status.state !== 'disconnected' ? 'disconnected' : status.state
    const since = state !== status.state ? Date.now() : status.since
    return {
        state,
        since,
        events: status.events.map((event) => ({ ...event })),
    }
}

let heartbeat: ReturnType<typeof setInterval> | undefined

export function startConnectionHeartbeat(): void {
    if (heartbeat) return
    void touchAlive()
    heartbeat = setInterval(() => {
        void touchAlive()
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
}

export async function markIngestShutdown(detail = 'ingest stopped'): Promise<void> {
    if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = undefined
    }
    const status = await readStored()
    setState(status, 'disconnected')
    pushEvent(status, 'disconnected', detail)
    await writeStatus(status)
    try {
        await redis.del(ALIVE_KEY)
    } catch (error) {
        log.warn({ err: String(error) }, 'connection_status.clear_alive_failed')
    }
}
