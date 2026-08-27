import { redis } from './cache.js'
import { config } from './config.js'

function jitter(minMs: number, maxMs: number): number {
    if (maxMs <= minMs) return minMs
    return minMs + Math.floor(Math.random() * (maxMs - minMs + 1))
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createSerialQueue() {
    let chain: Promise<unknown> = Promise.resolve()
    return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = chain.then(fn, fn) as Promise<T>
        chain = run.then(
            () => undefined,
            () => undefined
        )
        return run
    }
}

async function waitSlot(key: string, minMs: number, maxMs: number): Promise<number> {
    const delay = jitter(minMs, maxMs)
    const now = Date.now()
    const lastRaw = await redis.get(key)
    const last = lastRaw ? Number.parseInt(lastRaw, 10) : 0
    const waitMs = last > 0 ? Math.max(0, last + delay - now) : 0
    if (waitMs > 0) await sleep(waitMs)
    await redis.set(key, String(Date.now()))
    return waitMs
}

const historyRequestQueue = createSerialQueue()
const mediaQueue = createSerialQueue()

export function waitHistoryRequest(): Promise<number> {
    return historyRequestQueue(() =>
        waitSlot('ratelimit:history-request', config.historyRequestMinMs, config.historyRequestMaxMs)
    )
}

export function waitMediaDownload(): Promise<number> {
    return mediaQueue(() =>
        waitSlot('ratelimit:media', config.mediaDelayMinMs, config.mediaDelayMaxMs)
    )
}

export function settleDelayMs(): number {
    return jitter(config.historySettleMinMs, config.historySettleMaxMs)
}

export function retryBackoffMs(attempts: number, minMs: number, maxMs: number): number {
    const shift = Math.max(0, attempts - 1)
    const exp = Math.min(maxMs, minMs * 2 ** Math.min(shift, 10))
    return jitter(minMs, Math.max(minMs, Math.floor(exp)))
}
