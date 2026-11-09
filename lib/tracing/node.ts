import { waitUntil } from '@vercel/functions'
import { CompositePropagator, W3CTraceContextPropagator, ExportResultCode, type ExportResult } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { SERVICE_NAME, traceSettings, type TraceEnvironment } from './config'
import { sanitizeSpan } from './sanitize'
import { RouteAttributesProcessor, pgRequestHook, pgResponseHook } from './spans'
import { RunContextPropagator } from './context'
import { RetainingSpanProcessor, RunSampler } from './sampling'
import { createLogProvider, StageLogProcessor } from './logs'
import { flushTelemetry, registerTelemetryFlush } from './flush'
import type { Logger } from '@opentelemetry/api-logs'

// Node-runtime tracing, started by instrumentation.ts (docs/operations/tracing.md).
// OpenTelemetry with Next's own request spans plus one span per pg statement,
// exported to PostHog over OTLP HTTP/protobuf.

/** After a failed export, spans are dropped for this long instead of retried. */
export const EXPORT_PAUSE_MS = 60_000

/**
 * Sanitizes every span, then exports. Never reports a failure: the batch
 * processor would log it, and a failure pauses exporting for a minute so an
 * unreachable collector costs one attempt, not one per batch.
 */
export class SafeExporter implements SpanExporter {
  private pausedUntil = 0
  constructor(private readonly inner: SpanExporter, private readonly now: () => number = Date.now) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    if (this.now() < this.pausedUntil) return done({ code: ExportResultCode.SUCCESS })
    let clean: ReadableSpan[]
    try { clean = spans.map(sanitizeSpan) } catch { return done({ code: ExportResultCode.SUCCESS }) }
    try {
      this.inner.export(clean, result => {
        if (result.code !== ExportResultCode.SUCCESS) this.pausedUntil = this.now() + EXPORT_PAUSE_MS
        done({ code: ExportResultCode.SUCCESS })
      })
    } catch {
      this.pausedUntil = this.now() + EXPORT_PAUSE_MS
      done({ code: ExportResultCode.SUCCESS })
    }
  }
  shutdown(): Promise<void> { return this.inner.shutdown().catch(() => {}) }
  forceFlush(): Promise<void> { return this.inner.forceFlush?.().catch(() => {}) ?? Promise.resolve() }
}

/**
 * On Vercel a function may freeze once its response is sent, before the batch
 * timer fires. When a request's root span ends, hand a flush to waitUntil, the
 * way PostHog's Next.js guide flushes in after(). Outside Vercel it is a no-op
 * and the batch timer exports.
 */
class FlushOnRootEnd implements SpanProcessor {
  constructor(private readonly flush: () => Promise<void>, private readonly serverless: boolean) {}
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    if (!this.serverless) return
    // Deferred jobs can outlive an ended local request. Their flush is retained too.
    if (span.parentSpanContext && !span.parentSpanContext.isRemote && !String(span.attributes['mikka.route']).startsWith('after:')) return
    try { waitUntil(this.flush().catch(() => {})) } catch { /* not in a request */ }
  }
  forceFlush(): Promise<void> { return Promise.resolve() }
  shutdown(): Promise<void> { return Promise.resolve() }
}

export type ProviderOptions = { exporter: SpanExporter; sampleRate: number; environment: TraceEnvironment; version?: string; logger?: Logger; serverless?: boolean; batch?: { scheduledDelayMillis?: number } }

export function createTracerProvider({ exporter, sampleRate, environment, version, logger, serverless = process.env.VERCEL === '1', batch }: ProviderOptions): NodeTracerProvider {
  const batcher = new BatchSpanProcessor(exporter, { maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: batch?.scheduledDelayMillis ?? 5_000, exportTimeoutMillis: 10_000 })
  return new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      ...(version ? { [ATTR_SERVICE_VERSION]: version } : {}),
      'deployment.environment': environment,
      'deployment.environment.name': environment,
    }),
    sampler: new RunSampler(sampleRate),
    // Logs see the retained span, including the effective rate after a tail
    // promotion, so APM and native Logs describe the same sampling decision.
    // The SDK batch flush drains queued spans, but not an export its timer
    // already started. Keep that transport in waitUntil as well.
    spanProcessors: [new RouteAttributesProcessor(), new RetainingSpanProcessor(logger ? new StageLogProcessor(logger, batcher) : batcher), new FlushOnRootEnd(async () => { await Promise.allSettled([batcher.forceFlush().finally(() => exporter.forceFlush?.()), flushTelemetry()]) }, serverless)],
  })
}

export function createPgInstrumentation(): PgInstrumentation {
  return new PgInstrumentation({
    // Never record parameter values or rewrite statements (pg_stat_statements groups on the text).
    enhancedDatabaseReporting: false,
    addSqlCommenterCommentToQueries: false,
    enableTraceContextPropagation: false,
    // Only queries inside a request or action; connection spans would double the volume.
    requireParentSpan: true,
    ignoreConnectSpans: true,
    requestHook: pgRequestHook,
    responseHook: pgResponseHook,
  })
}

const started = Symbol.for('mikka.tracing')

/** Registers the global tracer once per process. Returns null when tracing is off (no token, or a sample rate of 0). */
export function startTracing(env: Record<string, string | undefined> = process.env): NodeTracerProvider | null {
  const global = globalThis as Record<symbol, NodeTracerProvider | null | undefined>
  if (global[started] !== undefined) return global[started]
  const settings = traceSettings(env)
  if (!settings) return (global[started] = null)
  // Workflow SDK 5 supports durable W3C carrier propagation. Its default
  // linked mode deliberately splits every delivery; a Mikka run is continuous.
  process.env.WORKFLOW_TRACE_MODE = 'continuous'
  const exporter = new SafeExporter(new OTLPTraceExporter({ url: settings.endpoint, headers: { Authorization: `Bearer ${settings.token}` }, timeoutMillis: 5_000 }))
  const logs = createLogProvider(settings)
  registerTelemetryFlush(() => logs.forceFlush({ timeoutMillis: 10_000 }))
  const provider = createTracerProvider({ exporter, sampleRate: settings.sampleRate, environment: settings.environment, version: settings.version, logger: logs.getLogger('mikka.run'), serverless: env.VERCEL === '1' })
  provider.register({ propagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new RunContextPropagator()] }) })
  registerInstrumentations({ tracerProvider: provider, instrumentations: [createPgInstrumentation()] })
  return (global[started] = provider)
}
