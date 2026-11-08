import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { ROOT_CONTEXT, SpanStatusCode, isSpanContextValid, trace, type Attributes, type AttributeValue, type Context, type Span } from "@opentelemetry/api"
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider, BatchSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import type { LoggerProvider, LogRecordExporter } from "@opentelemetry/sdk-logs"
import type { DeviceRegistered } from "@mikka/protocol/device"
import { HARNESSES, type Harness } from "@mikka/protocol/harness"
import { safeErrorAttributes, scrubLocalString } from "@mikka/protocol/tracing"
import { TRACE_FIELDS, runTraceHeaders, sanitizeTraceContext, telemetryId, traceAttributes, type RunTraceContext } from "@mikka/protocol/trace-context"
import { createLogProvider, StageLogProcessor } from "./tracing-logs"
import { AI_METADATA, AI_NUMBERS, createAiSink, generationAttributes, generationEvent, modelLabel, type AiSink, type GenerationMetrics } from "./tracing-ai"
import { DaemonRetainingSpanProcessor, DaemonSampler, RETENTIONS, RUN_CONTEXT, sampleRate, spanSamplingAttributes } from "./tracing-sampling"

// Traces of the daemon's own operations (docs/operations/tracing.md, "Daemon"):
// runs, their start-up stages, the gateway connection, tool approval and each
// call to the server, plus numeric provider usage from supported SDK frames.
// Never prompts, responses, tool payloads, files, paths, env or credentials.
// Off until registration (or a trusted cloud bootstrap handoff) supplies
// public PostHog settings; `MIKKA_DAEMON_TRACING=0`
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
  "daemon.adapter.cli_init", "daemon.adapter.cli_init.prewarm", "daemon.adapter.account_check", "daemon.adapter.account_check.account_info",
  "daemon.adapter.account_check.login",
] as const)
type StartupPhaseName = typeof STARTUP_PHASES extends Set<infer Name> ? Name : never
export type DaemonStartupPhase = {
  name: StartupPhaseName
  /** Monotonic offsets from this receipt's start; parent and child intervals overlap. */
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
  /** Also true if a child was still pending when this measured boundary settled. */
  truncated: boolean
}
/** A task's early start, including its wait for checkout, with its own clock
 * origin. It is not a child interval of the later agent_start stage. */
export type DaemonPreparationTiming = DaemonStartupTiming & { source: 'prepared_agent_start' | 'bootstrap_claude_start' | 'bootstrap_codex_initialize'; claimAuthentication?: 'oauth_environment' | 'ordinary_path' | 'unverified'; observedAuthSource?: 'oauth_environment' | 'oauth_descriptor' | 'non_api_key_unspecified' | 'unknown' }
type StartupScope = {
  runIdHash: string; harness: Harness; startedAt: number; started: number
  phases: DaemonStartupPhase[]; phaseCount: number; truncated: boolean; closed: boolean
}
type SpanOptions = { root?: boolean; traceContext?: RunTraceContext; startedAt?: number; endedAt?: number; onStartupTiming?: (timing: DaemonStartupTiming) => void }
const milliseconds = (value: number) => Math.max(0, Math.round(value * 1_000) / 1_000)

/** The only attributes a daemon span may carry. Everything else is dropped before export. */
const ALLOWED = new Set([
  "mikka.route", "mikka.client_kind", "mikka.run.id_hash", "mikka.harness", "mikka.outcome",
  "mikka.error.code", "mikka.error.detail", "mikka.gateway.mode",
  "error.type", "http.request.method", "http.response.status_code", "url.path",
  "mikka.error.causes", "mikka.stage", "mikka.duration_ms", "mikka.status",
  "mikka.trace.sample_rate", "mikka.trace.critical", "mikka.trace.retention",
  ...Object.values(TRACE_FIELDS),
  ...Object.values(AI_NUMBERS).map(([attribute]) => attribute),
  ...AI_METADATA,
  "mikka.ai.provider", "mikka.ai.model", "mikka.ai.operation",
  "mikka.ai.native_generations", "mikka.ai.fallback_generations", "mikka.ai.matched_fallbacks", "mikka.ai.missing_native",
  "mikka.ai.incomplete_requests", "mikka.ai.invalid_spans", "mikka.ai.rejected_batches", "mikka.ai.duplicate_completions",
  "mikka.ai.collection_truncated", "mikka.ai.cli_exit_observed", "mikka.ai.native_flush_confirmed",
])
const ID_ATTRIBUTES = new Set<string>(Object.values(TRACE_FIELDS))

/** The sample rate the daemon uses: the server's, lowered (or turned off with 0) by `MIKKA_DAEMON_TRACE_SAMPLE_RATE`. */
export function daemonSampleRate(settings: TraceSettings, env: Env = process.env): number {
  const off = env.MIKKA_DAEMON_TRACING?.trim().toLowerCase()
  if (off === "0" || off === "false" || off === "off") return 0
  const local = Number(env.MIKKA_DAEMON_TRACE_SAMPLE_RATE?.trim() || NaN)
  const rate = Number.isFinite(local) ? Math.min(settings.sampleRate, Math.max(0, local)) : settings.sampleRate
  return Math.min(1, Math.max(0, rate))
}

/** Legacy correlation key retained for startup timing consumers. */
export function runIdHash(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 16)
}

/** `/v1/devices/<id>/runs/<id>/claim?x` → `/v1/devices/[id]/runs/[id]/claim`. Ids, queries and fragments never become a route. */
export function routeTemplate(path: string): string {
  const clean = path.split(/[?#]/, 1)[0]
  return clean.split("/").map(part => part === "" || part === "v1" || /^[a-z][a-z-]{0,39}$/.test(part) ? part : "[id]").join("/")
}

export function cleanAttributes(attributes: Attributes): Attributes {
  const clean: Attributes = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED.has(key)) continue
    if (key === "mikka.trace.sample_rate") { const rate = sampleRate(value); if (rate !== undefined) clean[key] = rate }
    else if (key === "mikka.trace.critical") { if (typeof value === "boolean") clean[key] = value }
    else if (key === "mikka.trace.retention") { if (typeof value === "string" && RETENTIONS.has(value)) clean[key] = value }
    else if (ID_ATTRIBUTES.has(key)) { if (telemetryId(value)) clean[key] = value }
    else if (key === "mikka.ai.model") { const model = modelLabel(value); if (model) clean[key] = model }
    else if (typeof value === "string") clean[key] = scrubLocalString(value)
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) clean[key] = value
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
const getter = { get: (carrier: Record<string, string>, key: string) => carrier[key], keys: (carrier: Record<string, string>) => Object.keys(carrier) }

export class DaemonTracer {
  private provider: BasicTracerProvider | null = null
  private logProvider: LoggerProvider | null = null
  private ai: AiSink | null = null
  private readonly generationDrains = new Set<Promise<unknown>>()
  private readonly scope = new AsyncLocalStorage<Context>()
  private readonly startupScope = new AsyncLocalStorage<StartupScope>()

  get enabled(): boolean { return this.provider !== null }
  get generationsEnabled(): boolean { return this.provider !== null && this.ai !== null }

  /** Only already-closing collectors register here; never wait for an active
   * model/CLI. Existing flush/shutdown budgets cover their final safe receipts. */
  registerGenerationDrain(work: Promise<unknown>): void {
    const safe = work.catch(() => {})
    this.generationDrains.add(safe)
    void safe.then(() => this.generationDrains.delete(safe))
  }

  /** Starts exporting with the server's settings. Called again (a new registration) it keeps the first provider. */
  configure(settings: TraceSettings | undefined, { version, env = process.env, exporter, logExporter, aiSink }: { version?: string; env?: Env; exporter?: SpanExporter; logExporter?: LogRecordExporter; aiSink?: AiSink | null } = {}): boolean {
    if (this.provider || !settings) return this.enabled
    try {
      const rate = daemonSampleRate(settings, env)
      if (rate <= 0) return false
      const inner = exporter ?? new OTLPTraceExporter({ url: settings.endpoint, headers: { Authorization: `Bearer ${settings.projectToken}` }, timeoutMillis: 5_000 })
      const environment = settings.environment ?? "production"
      const resource = resourceFromAttributes({
        "service.name": SERVICE_NAME,
        ...(version ? { "service.version": version } : {}),
        "deployment.environment": environment,
        "deployment.environment.name": environment,
      })
      this.logProvider = createLogProvider({ endpoint: settings.endpoint, projectToken: settings.projectToken, resource, sanitize: cleanAttributes, exporter: logExporter })
      this.ai = aiSink === undefined ? createAiSink(settings.endpoint, settings.projectToken) : aiSink
      this.provider = new BasicTracerProvider({
        resource,
        sampler: new DaemonSampler(rate),
        spanProcessors: [new DaemonRetainingSpanProcessor([
          new BatchSpanProcessor(new SafeExporter(inner), { maxQueueSize: 512, maxExportBatchSize: 256, scheduledDelayMillis: 10_000, exportTimeoutMillis: 10_000 }),
          new StageLogProcessor(this.logProvider.getLogger("mikka.daemon"), cleanAttributes),
        ])],
      })
    } catch {
      this.provider = null
      void this.logProvider?.shutdown().catch(() => {})
      this.logProvider = null
      void this.ai?.shutdown().catch(() => {})
      this.ai = null
    }
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
      return this.collectStartup({ runIdHash: hash, harness: harness as Harness },
        end => this.measuredSpan(name, attributes, work, options, end), options.onStartupTiming)
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

  /** Explicitly owns the earlier Promise's measurement context. This adds no
   * OTel root, request or timer; callers opt in before native preparation. */
  preparation<T>(identity: { runIdHash: string; harness: Harness }, work: () => Promise<T>,
    report: (timing: DaemonPreparationTiming) => void): Promise<T> {
    if (!/^[a-f0-9]{16}$/.test(identity.runIdHash) || !HARNESSES.includes(identity.harness)) return work()
    return this.collectStartup(identity, end => {
      let pending: Promise<T>
      try { pending = work() } catch (error) { end(true); throw error }
      return pending.then(value => { end(false); return value }, (error: unknown) => { end(true); throw error })
    }, timing => report({ ...timing, source: 'prepared_agent_start' }))
  }

  /** A task-local measurement begins at an accepted bootstrap and is entered
   * again only by that same candidate's fresh-claim preparation. Its real
   * earlier clock is retained; no interval is rebased into agent_start. */
  beginBootstrapPreparation(identity: { runIdHash: string; harness: 'claude_code' | 'codex' }) {
    const scope: StartupScope = { ...identity, startedAt: Date.now(), started: performance.now(),
      phases: [], phaseCount: 0, truncated: false, closed: false }
    let claimAuthentication: NonNullable<DaemonPreparationTiming['claimAuthentication']> = 'unverified'
    let observedAuthSource: NonNullable<DaemonPreparationTiming['observedAuthSource']> = 'unknown'
    let receipt: DaemonPreparationTiming | undefined
    return {
      authenticate: (source: NonNullable<DaemonPreparationTiming['claimAuthentication']>, observed: NonNullable<DaemonPreparationTiming['observedAuthSource']>) => {
        if (!scope.closed) { claimAuthentication = source; observedAuthSource = observed }
      },
      run: <T>(work: () => Promise<T>): Promise<T> => scope.closed ? this.startupScope.exit(work) : this.startupScope.run(scope, work),
      finish: (outcome: 'ok' | 'error') => {
        if (scope.closed) return
        scope.closed = true
        receipt = { version: 1, source: identity.harness === 'codex' ? 'bootstrap_codex_initialize' : 'bootstrap_claude_start', ...identity,
          ...(identity.harness === 'claude_code' ? { claimAuthentication, observedAuthSource } : {}),
          startedAt: scope.startedAt, endedAt: Date.now(), ms: milliseconds(performance.now() - scope.started), outcome,
          phases: scope.phases.sort((a, b) => a.startMs - b.startMs),
          truncated: scope.truncated || scope.phases.length < scope.phaseCount }
        scope.phases = []
      },
      get receipt() { return receipt },
    }
  }

  private collectStartup<T>(identity: { runIdHash: string; harness: Harness },
    work: (end: (failed: boolean) => void) => Promise<T>, report: (timing: DaemonStartupTiming) => void): Promise<T> {
    const scope: StartupScope = { ...identity, startedAt: Date.now(), started: performance.now(),
      phases: [], phaseCount: 0, truncated: false, closed: false }
    return this.startupScope.run(scope, () => work(failed => {
      scope.closed = true
      const timing: DaemonStartupTiming = { version: 1, runIdHash: scope.runIdHash, harness: scope.harness,
        startedAt: scope.startedAt, endedAt: Date.now(), ms: milliseconds(performance.now() - scope.started),
        outcome: failed ? 'error' : 'ok', phases: scope.phases.sort((a, b) => a.startMs - b.startMs),
        truncated: scope.truncated || scope.phases.length < scope.phaseCount }
      // Detached CLI callbacks retain the context, but never append after the
      // measured start has settled. The run-owned result holds only numbers.
      scope.phases = []
      try { report(timing) } catch { /* measurement never changes work */ }
    }))
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

  private traceSpan<T>(name: string, attributes: Record<string, Value>, work: (span: SpanHandle) => Promise<T>, { root = false, traceContext, startedAt, endedAt }: SpanOptions): Promise<T> {
    const provider = this.provider
    let span: Span | undefined
    let scope = root ? ROOT_CONTEXT : this.scope.getStore() ?? ROOT_CONTEXT
    try {
      const incoming = sanitizeTraceContext(traceContext)
      if (incoming) scope = propagator.extract(ROOT_CONTEXT, { traceparent: incoming.traceparent }, getter).setValue(RUN_CONTEXT, incoming)
      if (provider) {
        const initial = cleanAttributes({ "mikka.client_kind": "daemon",
          ...traceAttributes(scope.getValue(RUN_CONTEXT) as RunTraceContext | undefined), ...definedAttributes(attributes) })
        // Sampling metadata comes from the sampler's actual decision, never an
        // operation's arbitrary attributes. The carrier lives in the context.
        for (const key of Object.keys(initial)) if (key.startsWith("mikka.trace.")) delete initial[key]
        span = provider.getTracer("mikka.daemon").startSpan(name, { ...(startedAt === undefined ? {} : { startTime: new Date(startedAt) }), attributes: initial }, scope)
        scope = trace.setSpan(scope, span)
        const metadata = { ...(scope.getValue(RUN_CONTEXT) as RunTraceContext | undefined) }
        for (const [field, key] of Object.entries(TRACE_FIELDS)) {
          const value = attributes[key]
          if (telemetryId(value)) Object.assign(metadata, { [field]: value })
        }
        const parent = span.spanContext()
        metadata.sampleRate = sampleRate(spanSamplingAttributes(span)?.["mikka.trace.sample_rate"]) ?? sampleRate(metadata.sampleRate)
        scope = scope.setValue(RUN_CONTEXT, sanitizeTraceContext({ ...metadata,
          traceparent: `00-${parent.traceId}-${parent.spanId}-${parent.traceFlags.toString(16).padStart(2, "0")}` }))
      }
    } catch { span = undefined }
    const handle = span ? handleFor(span) : NOOP
    const end = (error?: unknown, failed = false) => {
      try {
        if (failed) {
          span?.setAttributes({ ...safeErrorAttributes(error), "mikka.outcome": outcomeOf(span) ?? "error" })
          span?.setStatus({ code: SpanStatusCode.ERROR })
        } else if (outcomeOf(span) === undefined) span?.setAttribute("mikka.outcome", "ok")
        span?.end(endedAt === undefined ? undefined : new Date(endedAt))
      } catch { /* tracing never breaks the daemon */ }
    }
    let pending: Promise<T>
    try { pending = this.scope.run(scope, () => work(handle)) } catch (error) { end(error, true); throw error }
    return pending.then(value => { end(); return value }, (error: unknown) => { end(error, true); throw error })
  }

  /** Carry only the opted-in startup recorder across an already parked Promise. */
  bindStartupTiming<Args extends unknown[], Result>(work: (...args: Args) => Result): (...args: Args) => Result {
    const scope = this.startupScope.getStore()
    return (...args) => scope && !scope.closed
      ? this.startupScope.run(scope, () => work(...args))
      : this.startupScope.exit(() => work(...args))
  }

  /** The current span plus validated run/session references, for delayed callbacks. */
  capture(): RunTraceContext | undefined {
    try {
      const active = this.scope.getStore(), span = active && trace.getSpanContext(active)
      if (!span || !isSpanContextValid(span)) return undefined
      return sanitizeTraceContext({ ...(active?.getValue(RUN_CONTEXT) as RunTraceContext | undefined),
        sampleRate: sampleRate(spanSamplingAttributes(trace.getSpan(active!))?.["mikka.trace.sample_rate"])
          ?? sampleRate((active?.getValue(RUN_CONTEXT) as RunTraceContext | undefined)?.sampleRate),
        traceparent: `00-${span.traceId}-${span.spanId}-${span.traceFlags.toString(16).padStart(2, "0")}` })
    } catch { return undefined }
  }

  /** Re-enter a captured run in an outbox or SDK callback without creating a span. */
  withContext<T>(carrier: RunTraceContext | undefined, work: () => T): T {
    const clean = sanitizeTraceContext(carrier)
    if (!clean) return work()
    const parent = propagator.extract(ROOT_CONTEXT, { traceparent: clean.traceparent }, getter).setValue(RUN_CONTEXT, clean)
    return this.scope.run(parent, work)
  }

  /** One completed provider generation, never a cumulative turn or session usage total. */
  generation(metrics: GenerationMetrics, carrier = this.capture()): void {
    if (!this.provider || !carrier) return
    const parentId = carrier.traceparent.slice(36, 52)
    const duration = metrics.latencyMs
    const nativeInterval = typeof metrics.startedAt === 'number' && Number.isFinite(metrics.startedAt) && metrics.startedAt >= 0
      && typeof metrics.endedAt === 'number' && Number.isFinite(metrics.endedAt) && metrics.endedAt >= metrics.startedAt
      && metrics.endedAt <= 8_640_000_000_000_000
    const startedAt = nativeInterval ? metrics.startedAt : typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? Date.now() - duration : undefined
    const endedAt = nativeInterval ? metrics.endedAt : undefined
    void this.span('daemon.ai.generation', generationAttributes(metrics), async span => {
      const active = this.capture()
      if (metrics.outcome === 'error') span.fail({ name: 'ProviderError' })
      // AI analytics follows the trace sampling decision, including a remote parent.
      if (active && (parseInt(active.traceparent.slice(-2), 16) & 1)) {
        const event = generationEvent(metrics, active, parentId, startedAt === undefined ? undefined : new Date(startedAt))
        if (event) { try { this.ai?.capture(event) } catch { /* Telemetry never blocks an agent. */ } }
      }
    }, { traceContext: carrier, startedAt, endedAt }).catch(() => {})
  }

  /** W3C parent and safe run references, confined to outgoing Mikka requests. */
  headers(): Record<string, string> {
    const carrier: Record<string, string> = {}
    try {
      const active = this.scope.getStore()
      if (this.provider && active) {
        Object.assign(carrier, runTraceHeaders(this.capture()))
        propagator.inject(active, carrier, setter)
      }
    } catch { /* a request goes out without trace context */ }
    return carrier
  }

  /** Exports what has ended, for at most `timeoutMs`; never delays shutdown longer. */
  async shutdown(timeoutMs = 2_000): Promise<void> {
    const provider = this.provider
    const logs = this.logProvider
    const ai = this.ai
    if (!provider && !logs && !ai) return
    const detach = () => {
      if (this.provider === provider) this.provider = null
      if (this.logProvider === logs) this.logProvider = null
      if (this.ai === ai) this.ai = null
    }
    const work = Promise.allSettled(this.generationDrains).then(async () => {
      detach()
      await Promise.allSettled([provider?.shutdown(), logs?.shutdown(), ai?.shutdown()])
    })
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      work,
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref() }),
    ]).finally(() => { clearTimeout(timer); detach() })
  }

  /** Run completion starts a background drain; tests can await the same queues. */
  async flush(): Promise<void> {
    try {
      await Promise.allSettled(this.generationDrains)
      await Promise.allSettled([this.provider?.forceFlush(), this.logProvider?.forceFlush(), this.ai?.flush()])
    }
    catch { /* A collector cannot break the run's completion. */ }
  }
}

export interface SpanHandle {
  set(key: string, value: Value): void
  /** Marks the span failed with this error's name and code, without throwing. */
  fail(error: unknown, outcome?: string): void
}

const NOOP: SpanHandle = { set() {}, fail() {} }

function handleFor(span: Span): SpanHandle {
  return {
    set(key, value) { try { if (value !== undefined && !key.startsWith("mikka.trace.")) span.setAttribute(key, value) } catch { /* ignored */ } },
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
