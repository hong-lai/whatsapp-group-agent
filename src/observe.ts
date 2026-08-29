import {
    metrics,
    SpanStatusCode,
    trace,
    type Attributes,
    type Span,
} from '@opentelemetry/api'

const tracer = trace.getTracer('whatsapp-group-agent')
const meter = metrics.getMeter('whatsapp-group-agent')

const messagesIngested = meter.createCounter('whatsapp.messages.ingested', {
    description: 'Messages processed by the WhatsApp ingest path',
})
const mediaDownloads = meter.createCounter('whatsapp.media.downloads', {
    description: 'Media download attempts by result',
})
const mediaDownloadDuration = meter.createHistogram('whatsapp.media.download.duration', {
    description: 'Media download duration',
    unit: 'ms',
})
const historySyncDuration = meter.createHistogram('whatsapp.history.sync.duration', {
    description: 'History sync batch duration',
    unit: 'ms',
})
const historySyncMessages = meter.createCounter('whatsapp.history.sync.messages', {
    description: 'Messages counted in a history sync batch',
})
const catchupRequests = meter.createCounter('whatsapp.catchup.requests', {
    description: 'Catchup history fetches',
})
const disconnects = meter.createCounter('whatsapp.disconnects', {
    description: 'WhatsApp session disconnects',
})
const httpRequests = meter.createCounter('http.server.requests', {
    description: 'Dashboard HTTP requests',
})
const httpDuration = meter.createHistogram('http.server.duration', {
    description: 'Dashboard HTTP request duration',
    unit: 'ms',
})

let catchupPending = 0
let connectionUp = 0
let lastCpu = process.cpuUsage()
let lastCpuAt = Date.now()

meter
    .createObservableGauge('whatsapp.catchup.pending', {
        description: 'Catchup jobs waiting to request history',
    })
    .addCallback((result) => {
        result.observe(catchupPending)
    })

meter
    .createObservableGauge('whatsapp.connection.up', {
        description: '1 if the WhatsApp session is connected',
    })
    .addCallback((result) => {
        result.observe(connectionUp)
    })

meter
    .createObservableGauge('process.memory.rss', {
        description: 'Process resident set size',
        unit: 'By',
    })
    .addCallback((result) => {
        result.observe(process.memoryUsage().rss)
    })

meter
    .createObservableGauge('process.memory.heap_used', {
        description: 'V8 heap used',
        unit: 'By',
    })
    .addCallback((result) => {
        result.observe(process.memoryUsage().heapUsed)
    })

meter
    .createObservableGauge('process.cpu.utilization', {
        description: 'Process CPU utilization since the last observation (1.0 = one core)',
        unit: '1',
    })
    .addCallback((result) => {
        const now = Date.now()
        const elapsedMs = now - lastCpuAt
        const usage = process.cpuUsage(lastCpu)
        lastCpu = process.cpuUsage()
        lastCpuAt = now
        if (elapsedMs > 0) {
            result.observe((usage.user + usage.system) / 1000 / elapsedMs)
        }
    })

export async function withSpan<T>(
    name: string,
    attributes: Attributes,
    fn: (span: Span) => Promise<T>
): Promise<T> {
    return tracer.startActiveSpan(name, { attributes }, async (span) => {
        try {
            return await fn(span)
        } catch (err) {
            if (err instanceof Error) span.recordException(err)
            span.setStatus({ code: SpanStatusCode.ERROR })
            throw err
        } finally {
            span.end()
        }
    })
}

export function recordMessageIngest(attrs: {
    result: string
    isHistory: boolean
    messageType: string
}): void {
    messagesIngested.add(1, {
        'whatsapp.message.result': attrs.result,
        'whatsapp.message.type': attrs.messageType,
        'whatsapp.message.history': attrs.isHistory,
    })
}

export function recordMediaDownload(attrs: {
    result: string
    messageType: string
    isHistory: boolean
    durationMs?: number
}): void {
    const labels = {
        'whatsapp.media.result': attrs.result,
        'whatsapp.message.type': attrs.messageType,
        'whatsapp.message.history': attrs.isHistory,
    }
    mediaDownloads.add(1, labels)
    if (attrs.durationMs != null) {
        mediaDownloadDuration.record(attrs.durationMs, labels)
    }
}

export function recordHistorySync(attrs: {
    syncType: unknown
    durationMs: number
    saved: number
    reaction: number
    ignored: number
    error: number
    edited: number
    tooOld: number
}): void {
    const syncType = attrs.syncType == null ? 'unknown' : String(attrs.syncType)
    historySyncDuration.record(attrs.durationMs, { 'whatsapp.history.sync_type': syncType })
    for (const [result, count] of Object.entries({
        saved: attrs.saved,
        reaction: attrs.reaction,
        ignored: attrs.ignored,
        error: attrs.error,
        edited: attrs.edited,
        too_old: attrs.tooOld,
    })) {
        if (count > 0) {
            historySyncMessages.add(count, {
                'whatsapp.history.sync_type': syncType,
                'whatsapp.message.result': result,
            })
        }
    }
}

export function recordCatchupRequest(attrs: {
    result: 'ok' | 'error' | 'skipped'
    reason: string
}): void {
    catchupRequests.add(1, {
        'whatsapp.catchup.result': attrs.result,
        'whatsapp.catchup.reason': attrs.reason,
    })
}

export function setCatchupPending(count: number): void {
    catchupPending = count
}

export function setConnectionUp(up: boolean): void {
    connectionUp = up ? 1 : 0
}

export function recordDisconnect(reason: string): void {
    disconnects.add(1, { 'whatsapp.disconnect.reason': reason })
}

export function recordHttpRequest(attrs: {
    method: string
    route: string
    status: number
    durationMs: number
}): void {
    const labels = {
        'http.method': attrs.method,
        'http.route': attrs.route,
        'http.status_code': attrs.status,
    }
    httpRequests.add(1, labels)
    httpDuration.record(attrs.durationMs, labels)
}
