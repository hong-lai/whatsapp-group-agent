import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
    AggregationType,
    InstrumentType,
    PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { config } from './config.js'
import { log } from './log.js'

let sdk: NodeSDK | undefined
let started = false

function otlpUrl(path: string): string {
    return `${config.otelEndpoint.replace(/\/$/, '')}${path}`
}

export async function startTelemetry(): Promise<void> {
    if (started || config.otelDisabled || !config.otelEndpoint) return
    started = true

    sdk = new NodeSDK({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: config.otelServiceName,
        }),
        traceExporter: new OTLPTraceExporter({ url: otlpUrl('/v1/traces') }),
        metricReader: new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: otlpUrl('/v1/metrics') }),
            exportIntervalMillis: config.otelExportIntervalMs,
        }),
        views: [
            {
                instrumentName: 'whatsapp.media.download.duration',
                instrumentType: InstrumentType.HISTOGRAM,
                aggregation: {
                    type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
                    options: { boundaries: [100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000] },
                },
            },
            {
                instrumentName: 'whatsapp.history.sync.duration',
                instrumentType: InstrumentType.HISTOGRAM,
                aggregation: {
                    type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
                    options: { boundaries: [50, 100, 250, 500, 1000, 2500, 5000, 15_000, 60_000] },
                },
            },
            {
                instrumentName: 'http.server.duration',
                instrumentType: InstrumentType.HISTOGRAM,
                aggregation: {
                    type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
                    options: { boundaries: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000] },
                },
            },
        ],
        instrumentations: [
            getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-fs': { enabled: false },
                '@opentelemetry/instrumentation-dns': { enabled: false },
                '@opentelemetry/instrumentation-net': { enabled: false },
            }),
        ],
    })

    await sdk.start()
    log.info(
        { endpoint: config.otelEndpoint, serviceName: config.otelServiceName },
        'telemetry.started'
    )
}

export async function shutdownTelemetry(): Promise<void> {
    if (!sdk) return
    await sdk.shutdown()
    sdk = undefined
}

await startTelemetry()
