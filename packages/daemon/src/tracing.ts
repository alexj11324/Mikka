import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type AttributeValue, type Context, type Span } from "@opentelemetry/api"
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import type { DeviceRegistered } from "@mikka/protocol/device"
import { safeErrorAttributes, scrubLocalString } from "@mikka/protocol/tracing"

// Traces of the daemon's own operations (docs/operations/tracing.md, "Daemon"):
// runs, their start-up stages, the gateway connection, tool approval and each
// call to the server. Never the agent CLI's own activity, prompts, files,
// paths, environment or credentials. Off until the server's registration
// response hands over its public PostHog settings; `MIKKA_DAEMON_TRACING=0`
// keeps it off. Nothing is registered globally, so code that loads its own
// OpenTelemetry (an agent SDK) is unaffected.

export const SERVICE_NAME = "mikka-daemon"
/** After a failed export, spans are dropped for this long instead of retried. */
export const EXPORT_PAUSE_MS = 60_000

export type TraceSettings = NonNullable<DeviceRegistered["tracing"]>
type Env = Record<string, string | undefined>
type Value = string | number | boolean | undefined

/** The only attributes a daemon span may carry. Everything else is dropped before export. */
const ALLOWED = new Set([
  "mikka.route", "mikka.client_kind", "mikka.run.id_hash", "mikka.harness", "mikka.outcome",
  "mikka.error.code", "mikka.error.detail", "mikka.gateway.mode",
  "error.type", "http.request.method", "http.response.status_code", "url.path",
])

/** The sample rate the daemon uses: the server's, lowered (or turned off with 0) by `MIKKA_DAEMON_TRACE_SAMPLE_RATE`. */
export function daemonSampleRate(settings: TraceSettings, env: Env = process.env): number {
  const off = env.MIKKA_DAEMON_TRACING?.trim().toLowerCase()
  if (off === "0" || off === "false" || off === "off") return 0
  const local = Number(env.MIKKA_DAEMON_TRACE_SAMPLE_RATE?.trim() || NaN)
  const rate = Number.isFinite(local) ? Math.min(settings.sampleRate, Math.max(0, local)) : settings.sampleRate
  return Math.min(1, Math.max(0, rate))
}

/** Same run, same hash, on every span; the run id itself never leaves the computer. */
export function runIdHash(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 16)
}

/** `/v1/devices/<id>/runs/<id>/claim?x` → `/v1/devices/[id]/runs/[id]/claim`. Ids, queries and fragments never become a route. */
export function routeTemplate(path: string): string {
  const clean = path.split(/[?#]/, 1)[0]
  return clean.split("/").map(part => part === "" || part === "v1" || /^[a-z][a-z-]{0,39}$/.test(part) ? part : "[id]").join("/")
}

function cleanAttributes(attributes: Attributes): Attributes {
  const clean: Attributes = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED.has(key)) continue
    if (typeof value === "string") clean[key] = scrubLocalString(value)
    else if (typeof value === "number" || typeof value === "boolean") clean[key] = value
  }
  return clean
}

/** A view of the span with only allowlisted, scrubbed attributes; no events, status message or link attributes. */
export function sanitizeSpan(span: ReadableSpan): ReadableSpan {
  return Object.create(span, {
    name: { value: scrubLocalString(span.name), enumerable: true },
    attributes: { value: cleanAttributes(span.attributes), enumerable: true },
    events: { value: [], enumerable: true },
    status: { value: { code: span.status.code }, enumerable: true },
    links: { value: span.links.map(link => ({ context: link.context })), enumerable: true },
    spanContext: { value: () => span.spanContext() },
  }) as ReadableSpan
}

/**
 * Sanitizes, then exports. Never reports a failure (the batch processor
 * would log it): a failed or thrown export drops its spans and pauses
 * exporting for a minute.
 */
export class SafeExporter implements SpanExporter {
  private pausedUntil = 0
  constructor(private readonly inner: SpanExporter, private readonly now: () => number = Date.now) {}
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    if (this.now() < this.pausedUntil) return done({ code: ExportResultCode.SUCCESS })
    try {
      this.inner.export(spans.map(sanitizeSpan), result => {
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

const propagator = new W3CTraceContextPropagator()
const setter = { set(carrier: Record<string, string>, key: string, value: string) { carrier[key] = value } }

export class DaemonTracer {
  private provider: BasicTracerProvider | null = null
  private readonly scope = new AsyncLocalStorage<Context>()

  get enabled(): boolean { return this.provider !== null }

  /** Starts exporting with the server's settings. Called again (a new registration) it keeps the first provider. */
  configure(settings: TraceSettings | undefined, { version, env = process.env, exporter }: { version?: string; env?: Env; exporter?: SpanExporter } = {}): boolean {
    if (this.provider || !settings) return this.enabled
    try {
      const rate = daemonSampleRate(settings, env)
      if (rate <= 0) return false
      const inner = exporter ?? new OTLPTraceExporter({ url: settings.endpoint, headers: { Authorization: `Bearer ${settings.projectToken}` }, timeoutMillis: 5_000 })
      const ratio = new TraceIdRatioBasedSampler(rate)
      const environment = settings.environment ?? "production"
      this.provider = new BasicTracerProvider({
        resource: resourceFromAttributes({
          "service.name": SERVICE_NAME,
          ...(version ? { "service.version": version } : {}),
          "deployment.environment": environment,
          "deployment.environment.name": environment,
        }),
        // The server samples a remote parent by the same trace-id ratio, so at
        // equal rates both sides keep or drop the same trace.
        sampler: new ParentBasedSampler({ root: ratio }),
        spanProcessors: [new BatchSpanProcessor(new SafeExporter(inner), { maxQueueSize: 512, maxExportBatchSize: 256, scheduledDelayMillis: 10_000, exportTimeoutMillis: 10_000 })],
      })
    } catch { this.provider = null }
    return this.enabled
  }

  /**
   * Runs `work` inside a span. The span records the outcome and, on a throw,
   * the error by name and code; tracing never changes the work's result or
   * throws into it. Without a configured provider it only runs `work`.
   */
  span<T>(name: string, attributes: Record<string, Value>, work: (span: SpanHandle) => Promise<T>, { root = false }: { root?: boolean } = {}): Promise<T> {
    const provider = this.provider
    if (!provider) return work(NOOP)
    let span: Span | undefined
    let scope: Context = ROOT_CONTEXT
    try {
      const parent = root ? ROOT_CONTEXT : this.scope.getStore() ?? ROOT_CONTEXT
      span = provider.getTracer("mikka.daemon").startSpan(name, { attributes: { "mikka.client_kind": "daemon", ...definedAttributes(attributes) } }, parent)
      scope = trace.setSpan(parent, span)
    } catch { span = undefined }
    const handle = span ? handleFor(span) : NOOP
    const end = (error?: unknown, failed = false) => {
      try {
        if (failed) {
          span?.setAttributes({ ...safeErrorAttributes(error), "mikka.outcome": outcomeOf(span) ?? "error" })
          span?.setStatus({ code: SpanStatusCode.ERROR })
        } else if (outcomeOf(span) === undefined) span?.setAttribute("mikka.outcome", "ok")
        span?.end()
      } catch { /* tracing never breaks the daemon */ }
    }
    let pending: Promise<T>
    try { pending = this.scope.run(scope, () => work(handle)) } catch (error) { end(error, true); throw error }
    return pending.then(value => { end(); return value }, (error: unknown) => { end(error, true); throw error })
  }

  /** `traceparent` for an outgoing request from the current span; empty without one. */
  headers(): Record<string, string> {
    const carrier: Record<string, string> = {}
    try {
      const active = this.scope.getStore()
      if (this.provider && active) propagator.inject(active, carrier, setter)
    } catch { /* a request goes out without trace context */ }
    return carrier
  }

  /** Exports what has ended, for at most `timeoutMs`; never delays shutdown longer. */
  async shutdown(timeoutMs = 2_000): Promise<void> {
    const provider = this.provider
    this.provider = null
    if (!provider) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      provider.shutdown().catch(() => {}),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref() }),
    ]).finally(() => clearTimeout(timer))
  }

  /** For tests: exports every ended span now. */
  async flush(): Promise<void> { await this.provider?.forceFlush().catch(() => {}) }
}

export interface SpanHandle {
  set(key: string, value: Value): void
  /** Marks the span failed with this error's name and code, without throwing. */
  fail(error: unknown, outcome?: string): void
}

const NOOP: SpanHandle = { set() {}, fail() {} }

function handleFor(span: Span): SpanHandle {
  return {
    set(key, value) { try { if (value !== undefined) span.setAttribute(key, value) } catch { /* ignored */ } },
    fail(error, outcome = "error") {
      try {
        span.setAttributes({ ...safeErrorAttributes(error), "mikka.outcome": outcome })
        span.setStatus({ code: SpanStatusCode.ERROR })
      } catch { /* ignored */ }
    },
  }
}

function definedAttributes(attributes: Record<string, Value>): Attributes {
  const out: Attributes = {}
  for (const [key, value] of Object.entries(attributes)) if (value !== undefined) out[key] = value as AttributeValue
  return out
}

function outcomeOf(span: Span | undefined): string | undefined {
  const value = (span as unknown as { attributes?: Attributes } | undefined)?.attributes?.["mikka.outcome"]
  return typeof value === "string" ? value : undefined
}

/** The daemon's one tracer. */
export const daemonTracer = new DaemonTracer()
