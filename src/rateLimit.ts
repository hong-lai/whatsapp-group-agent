import { redis } from './cache.js'
import { config } from './config.js'

let chain: Promise<unknown> = Promise.resolve()

function jitter(minMs: number, maxMs: number): number {
    if (maxMs <= minMs) return minMs
    return minMs + Math.floor(Math.random() * (maxMs - minMs + 1))
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitSlot(key: string, minMs: number, maxMs: number): Promise<void> {
    const delay = jitter(minMs, maxMs)
    const now = Date.now()
    const lastRaw = await redis.get(key)
    const last = lastRaw ? Number.parseInt(lastRaw, 10) : 0
    const waitMs = last > 0 ? Math.max(0, last + delay - now) : 0
    if (waitMs > 0) await sleep(waitMs)
    await redis.set(key, String(Date.now()))
}

function enqueue(fn: () => Promise<void>): Promise<void> {
    const run = chain.then(fn, fn)
    chain = run.then(() => undefined, () => undefined)
    return run
}

export function waitHistoryRead(): Promise<void> {
    return enqueue(() =>
        waitSlot('ratelimit:history', config.historyDelayMinMs, config.historyDelayMaxMs)
    )
}

export function waitMediaDownload(): Promise<void> {
    return enqueue(() =>
        waitSlot('ratelimit:media', config.mediaDelayMinMs, config.mediaDelayMaxMs)
    )
}
