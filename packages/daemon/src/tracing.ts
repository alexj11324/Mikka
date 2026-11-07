import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type AttributeValue, type Context, type Span } from "@opentelemetry/api"
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import type { DeviceRegistered } from "@mikka/protocol/device"
import { HARNESSES, type Harness } from "@mikka/protocol/harness"
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

/** Closed, content-free measurements carried by the existing agent_start chunk. */
export const STARTUP_TIMING_PHASE_LIMIT = 64
const STARTUP_PHASES = new Set([
  "daemon.adapter.model_report", "daemon.adapter.auth", "daemon.adapter.auth.gate",
  "daemon.adapter.auth.context", "daemon.adapter.auth.access", "daemon.adapter.auth.token",
  "daemon.adapter.auth.native_auth", "daemon.adapter.auth.refresh",
  "daemon.adapter.auth.broker", "daemon.adapter.workspace.shadow_clone", "daemon.adapter.workspace.read_tree",
  "daemon.adapter.cli_init", "daemon.adapter.account_check", "daemon.adapter.account_check.account_info",
  "daemon.adapter.account_check.login",
] as const)
type StartupPhaseName = typeof STARTUP_PHASES extends Set<infer Name> ? Name : never
export type DaemonStartupPhase = {
  name: StartupPhaseName
  /** Monotonic offsets from adapter.start; parent and child intervals overlap. */
  startMs: number
  endMs: number
  ms: number
  outcome: "ok" | "error"
}
export type DaemonStartupTiming = {
  version: 1
  runIdHash: string
  harness: Harness
  startedAt: number
  endedAt: number
  ms: number
  outcome: "ok" | "error"
  phases: DaemonStartupPhase[]
  /** Also true if a child was still pending when adapter.start ended. */
  truncated: boolean
}
type StartupScope = {
  runIdHash: string; harness: Harness; startedAt: number; started: number
  phases: DaemonStartupPhase[]; phaseCount: number; truncated: boolean; closed: boolean
}
type SpanOptions = { root?: boolean; onStartupTiming?: (timing: DaemonStartupTiming) => void }
const milliseconds = (value: number) => Math.max(0, Math.round(value * 1_000) / 1_000)

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
  private readonly startupScope = new AsyncLocalStorage<StartupScope>()

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
   * throws into it. Startup timings are independent of OTel configuration and
   * sampling. Only the fixed phase names and numeric intervals are retained.
   */
  span<T>(name: string, attributes: Record<string, Value>, work: (span: SpanHandle) => Promise<T>, options: SpanOptions = {}): Promise<T> {
    const hash = attributes["mikka.run.id_hash"], harness = attributes["mikka.harness"]
    if (name === "daemon.adapter.start" && options.onStartupTiming && typeof hash === "string" && /^[a-f0-9]{16}$/.test(hash)
      && HARNESSES.includes(harness as Harness)) {
      const scope: StartupScope = { runIdHash: hash, harness: harness as Harness, startedAt: Date.now(), started: performance.now(),
        phases: [], phaseCount: 0, truncated: false, closed: false }
      return this.startupScope.run(scope, () => this.measuredSpan(name, attributes, work, options, failed => {
        scope.closed = true
        const timing: DaemonStartupTiming = { version: 1, runIdHash: scope.runIdHash, harness: scope.harness,
          startedAt: scope.startedAt, endedAt: Date.now(), ms: milliseconds(performance.now() - scope.started),
          outcome: failed ? "error" : "ok", phases: scope.phases.sort((a, b) => a.startMs - b.startMs),
          truncated: scope.truncated || scope.phases.length < scope.phaseCount }
        // Long-lived CLI callbacks inherit this scope. Close it and release the
        // records before returning; later provider activity is not startup.
        scope.phases = []
        try { options.onStartupTiming?.(timing) } catch { /* measurement never changes work */ }
      }))
    }
    const scope = this.startupScope.getStore()
    if (scope && !scope.closed && !options.root && (hash === undefined || hash === scope.runIdHash)
      && (harness === undefined || harness === scope.harness) && STARTUP_PHASES.has(name as StartupPhaseName)) {
      if (scope.phaseCount >= STARTUP_TIMING_PHASE_LIMIT) scope.truncated = true
      else {
        scope.phaseCount++
        const started = performance.now()
        return this.measuredSpan(name, attributes, work, options, failed => {
          if (scope.closed) return
          const ended = performance.now()
          scope.phases.push({ name: name as StartupPhaseName, startMs: milliseconds(started - scope.started),
            endMs: milliseconds(ended - scope.started), ms: milliseconds(ended - started), outcome: failed ? "error" : "ok" })
        })
      }
    }
    if (options.root || name === "daemon.adapter.start") return this.startupScope.exit(() => this.traceSpan(name, attributes, work, options))
    return this.traceSpan(name, attributes, work, options)
  }

  private measuredSpan<T>(name: string, attributes: Record<string, Value>, work: (span: SpanHandle) => Promise<T>, options: SpanOptions, end: (failed: boolean) => void): Promise<T> {
    let failed = false, pending: Promise<T>
    try {
      pending = this.traceSpan(name, attributes, span => work({
        set: (key, value) => span.set(key, value),
        fail: (error, outcome) => { failed = true; span.fail(error, outcome) },
      }), options)
    } catch (error) { end(true); throw error }
    return pending.then(value => { end(failed); return value }, (error: unknown) => { end(true); throw error })
  }

  private traceSpan<T>(name: string, attributes: Record<string, Value>, work: (span: SpanHandle) => Promise<T>, { root = false }: SpanOptions): Promise<T> {
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
