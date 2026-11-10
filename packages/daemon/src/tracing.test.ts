import { afterEach, describe, expect, it } from "vitest"
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs"
import { ExportResultCode } from "@opentelemetry/core"
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import { CodedError } from "@mikka/protocol/coded-error"
import { HttpServerLink } from "./server-link-http"
import type { RunTraceContext } from '@mikka/protocol/trace-context'
import type { generationEvent } from './tracing-ai'
import { DaemonTracer, daemonSampleRate, daemonTracer, routeTemplate, runIdHash, SafeExporter, STARTUP_TIMING_PHASE_LIMIT, type DaemonStartupTiming, type TraceSettings } from "./tracing"

const settings: TraceSettings = { endpoint: "https://us.i.posthog.com/i/v1/traces", projectToken: "phc_testtoken123", sampleRate: 1, environment: "dev" }
const deviceId = "6f1c1f1e-3a5b-4c8d-9e0f-1a2b3c4d5e6f"

afterEach(async () => { await daemonTracer.shutdown() })

describe("daemon tracing", () => {
  it('retains complete critical runs without an incoming parent even at a tiny background rate', async () => {
    const spans = new InMemorySpanExporter(), tracer = new DaemonTracer()
    tracer.configure({ ...settings, sampleRate: Number.MIN_VALUE }, { exporter: spans, logExporter: new InMemoryLogRecordExporter(), aiSink: null, env: {} })
    await tracer.span('daemon.registration', {}, async () => {})
    await tracer.span('daemon.run', { 'mikka.run_id': 'legacy_run' }, () => tracer.span('POST /v1/runs/[id]/complete', {}, async () => {}), { root: true })
    await tracer.flush()
    expect(spans.getFinishedSpans().map(span => span.name).sort()).toEqual(['POST /v1/runs/[id]/complete', 'daemon.registration', 'daemon.run'])
    expect(spans.getFinishedSpans().every(span => span.attributes['mikka.trace.sample_rate'] === 1 && span.attributes['mikka.trace.critical'] === true)).toBe(true)
    await tracer.shutdown()
  })

  it('continues a dispatched run through HTTP, stage logs and numeric AI events', async () => {
    const spans = new InMemorySpanExporter(), logs = new InMemoryLogRecordExporter()
    const events: NonNullable<ReturnType<typeof generationEvent>>[] = []
    const carrier: RunTraceContext = { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      runId: 'e8c2ff88-b000-4000-8000-000000000001', threadId: 'e8c2ff88-b000-4000-8000-000000000002',
      taskId: 'e8c2ff88-b000-4000-8000-000000000003', workflowRunId: 'wfr_run123', posthogDistinctId: 'user_123', sessionId: 'browser_session123', sampleRate: 1 }
    daemonTracer.configure(settings, { exporter: spans, logExporter: logs, env: {}, aiSink: {
      capture: event => { events.push(event) }, flush: async () => {}, shutdown: async () => {},
    } })
    const seen: Headers[] = []
    const link = new HttpServerLink('https://mikka.test', async (_input, init) => { seen.push(new Headers(init?.headers)); return Response.json({ repos: [] }) })
    await daemonTracer.span('daemon.run', {}, async () => {
      expect(daemonTracer.capture()?.sampleRate).toBe(1)
      await daemonTracer.span('daemon.adapter.start', {}, async () => { await link.listRepos(deviceId) })
      daemonTracer.generation({ harness: 'claude_code', provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 120, outputTokens: 25, cacheReadTokens: 100, ttftMs: 150, latencyMs: 500 })
    }, { root: true, traceContext: carrier })
    await daemonTracer.flush()
    const finished = spans.getFinishedSpans(), run = finished.find(span => span.name === 'daemon.run')!
    const generation = finished.find(span => span.name === 'daemon.ai.generation')!
    expect(run.parentSpanContext?.spanId).toBe('0123456789abcdef')
    expect(finished.every(span => span.spanContext().traceId === carrier.traceparent.slice(3, 35))).toBe(true)
    expect(finished.every(span => span.attributes['mikka.run_id'] === carrier.runId)).toBe(true)
    expect(finished.every(span => span.attributes['mikka.trace.sample_rate'] === 1)).toBe(true)
    expect(seen[0].get('x-mikka-trace-runid')).toBe(carrier.runId)
    expect(seen[0].get('x-mikka-trace-sessionid')).toBe(carrier.sessionId)
    expect(seen[0].has('x-mikka-trace-samplerate')).toBe(false)
    const records = logs.getFinishedLogRecords()
    expect(records.length).toBe(3)
    expect(records.every(record => record.spanContext?.traceId === run.spanContext().traceId)).toBe(true)
    expect(records.every(record => record.body === 'mikka.stage.completed')).toBe(true)
    expect(records.every(record => record.attributes['mikka.trace.sample_rate'] === 1)).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0].properties).toMatchObject({ '$ai_trace_id': run.spanContext().traceId, '$ai_span_id': generation.spanContext().spanId,
      '$ai_parent_id': run.spanContext().spanId, '$ai_session_id': carrier.sessionId, '$ai_input_tokens': 120,
      '$session_id': carrier.sessionId, '$ai_time_to_first_token': 0.15, '$ai_latency': 0.5, '$ai_cache_reporting_exclusive': false })
    expect(events[0].properties).not.toHaveProperty('$ai_input')
    expect(events[0].properties).not.toHaveProperty('$ai_output_choices')
  })

  it('drops unsafe carrier metadata and exports bounded error causes without messages', async () => {
    const spans = new InMemorySpanExporter(), logs = new InMemoryLogRecordExporter(), tracer = new DaemonTracer()
    tracer.configure(settings, { exporter: spans, logExporter: logs, aiSink: null, env: {} })
    const carrier = { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', runId: 'run_safe',
      sessionId: 'alice@example.com', posthogDistinctId: 'phx_private_key', prompt: 'private prompt' } as RunTraceContext
    const error = new CodedError('subscription_local_runtime_unavailable', { detail: 'adapter_start_failed', cause: new Error('private prompt and sk-private') })
    await expect(tracer.span('daemon.adapter.start', {}, async () => { throw error }, { traceContext: carrier })).rejects.toBe(error)
    await tracer.flush()
    const [record] = logs.getFinishedLogRecords()
    expect(record.body).toBe('mikka.stage.failed')
    expect(record.spanContext?.traceId).toBe(carrier.traceparent.slice(3, 35))
    expect(record.attributes['mikka.error.causes']).toBeDefined()
    const payload = JSON.stringify({ attributes: record.attributes, spans: spans.getFinishedSpans().map(span => span.attributes) })
    for (const secret of ['alice', 'phx_', 'private prompt', 'sk-private']) expect(payload).not.toContain(secret)
    await tracer.shutdown()
  })

  it('preserves actual native generation timestamps after delayed export and labels first-output TTFT', async () => {
    const spans = new InMemorySpanExporter(), tracer = new DaemonTracer()
    const events: NonNullable<ReturnType<typeof generationEvent>>[] = []
    expect(tracer.generationsEnabled).toBe(false)
    tracer.configure(settings, { exporter: spans, logExporter: new InMemoryLogRecordExporter(), env: {}, aiSink: {
      capture: event => { events.push(event) }, flush: async () => {}, shutdown: async () => {},
    } })
    const startedAt = 1_793_980_800_000, endedAt = startedAt + 500
    const carrier = { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', runId: 'native_run' }
    expect(tracer.generationsEnabled).toBe(true)
    await tracer.span('daemon.run', {}, async () => {
      tracer.generation({ harness: 'codex', provider: 'openai', model: 'gpt-6-luna', inputTokens: 50, outputTokens: 20,
        startedAt, endedAt, latencyMs: 500, ttftMs: 150, firstOutputMs: 150,
        timingBasis: 'official_cli_trace', ttftBasis: 'request_to_first_output_item', modelBasis: 'native_sampling_config' })
    }, { traceContext: carrier })
    await tracer.flush()
    const generation = spans.getFinishedSpans().find(span => span.name === 'daemon.ai.generation')!
    const millis = (time: [number, number]) => time[0] * 1000 + time[1] / 1_000_000
    expect(millis(generation.startTime)).toBe(startedAt)
    expect(millis(generation.endTime)).toBe(endedAt)
    expect(millis(generation.duration)).toBe(500)
    expect(events[0].timestamp?.getTime()).toBe(startedAt)
    expect(events[0].properties).toMatchObject({ $ai_latency: 0.5, $ai_time_to_first_token: 0.15,
      'mikka.ai.timing_basis': 'official_cli_trace', 'mikka.ai.ttft_basis': 'request_to_first_output_item',
      'mikka.ai.first_output_item_ms': 150, 'mikka.ai.model_basis': 'native_sampling_config' })
    expect(generation.attributes['mikka.ai.ttft_basis']).toBe('request_to_first_output_item')
    await tracer.shutdown()
    expect(tracer.generationsEnabled).toBe(false)
  })

  it('drains already-closing generation collectors before shutting down the sink within the existing deadline', async () => {
    const spans = new InMemorySpanExporter(), tracer = new DaemonTracer()
    const events: NonNullable<ReturnType<typeof generationEvent>>[] = []
    let sinkClosed = false
    tracer.configure(settings, { exporter: spans, logExporter: new InMemoryLogRecordExporter(), env: {}, aiSink: {
      capture: event => { expect(sinkClosed).toBe(false); events.push(event) }, flush: async () => {}, shutdown: async () => { sinkClosed = true },
    } })
    const carrier = { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', runId: 'native_drain' }
    tracer.registerGenerationDrain(new Promise<void>(resolve => setImmediate(() => {
      tracer.generation({ harness: 'codex', provider: 'openai', model: 'gpt-6-luna', inputTokens: 5, outputTokens: 1,
        timingBasis: 'app_server_usage' }, carrier)
      resolve()
    })))
    await tracer.shutdown(100)
    expect(events).toHaveLength(1)
    expect(sinkClosed).toBe(true)
    expect(tracer.generationsEnabled).toBe(false)
    const stalled = new DaemonTracer()
    stalled.configure(settings, { exporter: new InMemorySpanExporter(), logExporter: new InMemoryLogRecordExporter(), aiSink: null, env: {} })
    let release!: () => void
    stalled.registerGenerationDrain(new Promise<void>(resolve => { release = resolve }))
    const started = performance.now()
    await stalled.shutdown(20)
    expect(performance.now() - started).toBeLessThan(250)
    expect(stalled.enabled).toBe(false)
    release()
  })

  it("exports only allowlisted, scrubbed attributes", async () => {
    const memory = new InMemorySpanExporter()
    const tracer = new DaemonTracer()
    expect(tracer.configure(settings, { exporter: memory, logExporter: new InMemoryLogRecordExporter(), aiSink: null, env: {} })).toBe(true)
    await tracer.span("daemon.run /Users/alex/secret-project", {
      "mikka.run.id_hash": runIdHash("run_1"),
      "mikka.harness": "claude_code",
      "mikka.route": "/v1/runs/[id] in /home/alex/work?token=abc",
      prompt: "fix the bug in /Users/alex/x", "process.env.HOME": "/Users/alex", "user.email": "alice@example.com", token: "sk-private",
    }, async span => {
      span.set("file.content", "private source")
      span.set("mikka.error.detail", "alice@example.com")
    })
    await tracer.flush()
    const [span] = memory.getFinishedSpans()
    expect(span.name).toBe("daemon.run [home]")
    expect(Object.keys(span.attributes).sort()).toEqual(["mikka.client_kind", "mikka.error.detail", "mikka.harness", "mikka.outcome", "mikka.route", "mikka.run.id_hash", "mikka.trace.critical", "mikka.trace.retention", "mikka.trace.sample_rate"])
    expect(span.attributes["mikka.route"]).toBe("/v1/runs/[id] in [home]")
    expect(span.attributes["mikka.run.id_hash"]).toMatch(/^[0-9a-f]{16}$/)
    expect(span.resource.attributes["service.name"]).toBe("mikka-daemon")
    const payload = JSON.stringify(memory.getFinishedSpans().map(s => ({ name: s.name, attributes: s.attributes, events: s.events })))
    for (const secret of ["alex", "alice", "sk-private", "private source", "token=abc", "run_1"]) expect(payload).not.toContain(secret)
    await tracer.shutdown()
  })

  it("records a failed operation by error code, never its message, and rethrows unchanged", async () => {
    const memory = new InMemorySpanExporter()
    const tracer = new DaemonTracer()
    tracer.configure(settings, { exporter: memory, logExporter: new InMemoryLogRecordExporter(), aiSink: null, env: {} })
    const error = new CodedError("subscription_local_runtime_unavailable", { detail: "adapter_start_failed", cause: new Error("spawn /Users/alex/.local/bin/claude ENOENT") })
    await expect(tracer.span("daemon.adapter.start", { "mikka.harness": "claude_code" }, async () => { throw error })).rejects.toBe(error)
    await tracer.flush()
    const [span] = memory.getFinishedSpans()
    expect(span.status.code).toBe(2)
    expect(span.status.message).toBeUndefined()
    expect(span.attributes["mikka.error.code"]).toBe("subscription_local_runtime_unavailable")
    expect(span.attributes["mikka.error.detail"]).toBe("adapter_start_failed")
    expect(span.attributes["mikka.outcome"]).toBe("error")
    expect(span.attributes["mikka.trace.sample_rate"]).toBe(1)
    expect(span.attributes["mikka.trace.critical"]).toBe(true)
    expect(JSON.stringify(span.attributes)).not.toContain("alex")
    await tracer.shutdown()
  })

  it("joins /v1 calls to the active span with a traceparent the server continues", async () => {
    const memory = new InMemorySpanExporter()
    daemonTracer.configure(settings, { exporter: memory, logExporter: new InMemoryLogRecordExporter(), aiSink: null, env: {} })
    const seen: Headers[] = []
    const link = new HttpServerLink("https://mikka.test/mikka", async (_input, init) => {
      seen.push(new Headers(init?.headers))
      return Response.json({ repos: [] })
    })
    await daemonTracer.span("daemon.run", { "mikka.run.id_hash": runIdHash("run_2") }, () => link.listRepos(deviceId), { root: true })
    await daemonTracer.flush()
    const spans = memory.getFinishedSpans()
    const run = spans.find(span => span.name === "daemon.run") as ReadableSpan
    const call = spans.find(span => span.name.startsWith("GET ")) as ReadableSpan
    expect(call.name).toBe("GET /v1/devices/[id]/repos")
    expect(call.attributes["http.response.status_code"]).toBe(200)
    expect(call.parentSpanContext?.spanId).toBe(run.spanContext().spanId)
    const traceparent = seen[0].get("traceparent")
    expect(traceparent).toBe(`00-${call.spanContext().traceId}-${call.spanContext().spanId}-01`)
    expect(call.spanContext().traceId).toBe(run.spanContext().traceId)
    expect(JSON.stringify(spans.map(span => [span.name, span.attributes]))).not.toContain(deviceId)
  })

  it("a failing, throwing or hanging exporter never changes or delays daemon work", async () => {
    const exporters: SpanExporter[] = [
      { export: (_spans, done) => done({ code: ExportResultCode.FAILED, error: new Error("collector down") }), shutdown: async () => {} },
      { export: () => { throw new Error("boom") }, shutdown: async () => { throw new Error("boom") } },
      { export: () => { /* never answers */ }, shutdown: () => new Promise(() => {}) },
    ]
    for (const exporter of exporters) {
      const tracer = new DaemonTracer()
      tracer.configure(settings, { exporter, logExporter: new InMemoryLogRecordExporter(), aiSink: null, env: {} })
      for (let i = 0; i < 5; i++) expect(await tracer.span("daemon.run", {}, async () => i)).toBe(i)
      await expect(tracer.span("daemon.run", {}, async () => { throw new TypeError("work failed") })).rejects.toThrow("work failed")
      const started = Date.now()
      await tracer.shutdown(200)
      expect(Date.now() - started).toBeLessThan(2_000)
    }
  })

  it("SafeExporter drops spans and pauses after a failure instead of retrying", () => {
    let calls = 0, now = 0
    const safe = new SafeExporter({ export: (_spans, done) => { calls++; done({ code: ExportResultCode.FAILED }) }, shutdown: async () => {} }, () => now)
    const results: number[] = []
    safe.export([], result => results.push(result.code))
    safe.export([], result => results.push(result.code))
    now = 61_000
    safe.export([], result => results.push(result.code))
    expect(calls).toBe(2)
    expect(results).toEqual([ExportResultCode.SUCCESS, ExportResultCode.SUCCESS, ExportResultCode.SUCCESS])
  })

  it("stays off without server settings or when turned off locally, and sends no trace headers", async () => {
    const tracer = new DaemonTracer()
    expect(tracer.configure(undefined)).toBe(false)
    expect(tracer.configure(settings, { env: { MIKKA_DAEMON_TRACING: "0" } })).toBe(false)
    expect(tracer.configure(settings, { env: { MIKKA_DAEMON_TRACE_SAMPLE_RATE: "0" } })).toBe(false)
    expect(await tracer.span("daemon.run", {}, async () => "ran")).toBe("ran")
    expect(tracer.headers()).toEqual({})
    const seen: Headers[] = []
    const link = new HttpServerLink("https://mikka.test", async (_input, init) => { seen.push(new Headers(init?.headers)); return Response.json({ repos: [] }) })
    await link.listRepos(deviceId)
    expect(seen[0].has("traceparent")).toBe(false)
  })

  it("samples at the server's rate, lowered but never raised locally", () => {
    expect(daemonSampleRate({ ...settings, sampleRate: 0.1 }, {})).toBe(0.1)
    expect(daemonSampleRate({ ...settings, sampleRate: 0.1 }, { MIKKA_DAEMON_TRACE_SAMPLE_RATE: "1" })).toBe(0.1)
    expect(daemonSampleRate({ ...settings, sampleRate: 0.1 }, { MIKKA_DAEMON_TRACE_SAMPLE_RATE: "0.05" })).toBe(0.05)
    expect(daemonSampleRate({ ...settings, sampleRate: 0.1 }, { MIKKA_DAEMON_TRACING: "off" })).toBe(0)
  })

  it("turns request paths into route templates without ids or queries", () => {
    expect(routeTemplate(`/v1/devices/${deviceId}/runs/run_abc123/claim`)).toBe("/v1/devices/[id]/runs/[id]/claim")
    expect(routeTemplate("/v1/runs/r1/skill-receipt?receiptId=secret")).toBe("/v1/runs/[id]/skill-receipt")
    expect(routeTemplate("/v1/devices/register")).toBe("/v1/devices/register")
  })
})

describe("unsampled startup timings", () => {
  const attributes = { "mikka.run.id_hash": runIdHash("private-run"), "mikka.harness": "claude_code" }

  it("captures closed numeric intervals with tracing disabled, excluding arbitrary names and private attributes", async () => {
    const tracer = new DaemonTracer(), records: DaemonStartupTiming[] = []
    expect(tracer.configure({ ...settings, sampleRate: 0 })).toBe(false)
    const result = await tracer.span("daemon.adapter.start", { ...attributes, prompt: "private-prompt" }, async () => {
      await tracer.span("daemon.adapter.auth", attributes, async () => {
        await tracer.span("daemon.adapter.auth.gate", { ...attributes, token: "private-token" }, async span => {
          span.set("path", "/home/private-file")
          return 1
        })
      })
      await tracer.span("daemon.adapter.cli_init", attributes, async span => { span.fail(new Error("private-error"), "private-outcome") })
      await tracer.span("daemon.adapter.private-prompt", attributes, async () => 1)
      await tracer.span("daemon.adapter.auth.context", { ...attributes, "mikka.run.id_hash": runIdHash("other-run") }, async () => 1)
      await tracer.span("daemon.adapter.auth.context", { ...attributes, "mikka.harness": "codex" }, async () => 1)
      await tracer.span("daemon.run", attributes, () => tracer.span("daemon.adapter.auth.context", attributes, async () => 1), { root: true })
      return 42
    }, { onStartupTiming: timing => records.push(timing) })
    expect(result).toBe(42)
    expect(tracer.headers()).toEqual({})
    expect(records).toHaveLength(1)
    const timing = records[0]
    expect(timing).toMatchObject({ version: 1, runIdHash: attributes["mikka.run.id_hash"], harness: "claude_code", outcome: "ok", truncated: false })
    expect(timing.endedAt).toBeGreaterThanOrEqual(timing.startedAt)
    expect(timing.phases.map(phase => phase.name)).toEqual(["daemon.adapter.auth", "daemon.adapter.auth.gate", "daemon.adapter.cli_init"])
    expect(timing.phases[2].outcome).toBe("error")
    expect(timing.phases[0].startMs).toBeLessThanOrEqual(timing.phases[1].startMs)
    expect(timing.phases[0].endMs).toBeGreaterThanOrEqual(timing.phases[1].endMs)
    for (const phase of timing.phases) {
      expect(Object.keys(phase).sort()).toEqual(["endMs", "ms", "name", "outcome", "startMs"])
      expect(phase.startMs).toBeGreaterThanOrEqual(0)
      expect(phase.endMs).toBeGreaterThanOrEqual(phase.startMs)
      expect(timing.ms).toBeGreaterThanOrEqual(phase.endMs)
      expect(Math.abs(phase.ms - (phase.endMs - phase.startMs))).toBeLessThanOrEqual(0.002)
    }
    expect(JSON.stringify(records)).not.toMatch(/private-|other-run|\/home/)
  })

  it("preserves synchronous and asynchronous errors and ignores a throwing measurement callback", async () => {
    const tracer = new DaemonTracer(), records: DaemonStartupTiming[] = []
    const error = new Error("private-start-error")
    const options = { onStartupTiming: (timing: DaemonStartupTiming) => { records.push(timing); throw new Error("callback-error") } }
    expect(() => tracer.span("daemon.adapter.start", attributes, () => { throw error }, options)).toThrow(error)
    await expect(tracer.span("daemon.adapter.start", attributes,
      () => tracer.span("daemon.adapter.auth.context", attributes, async () => { throw error }), options)).rejects.toBe(error)
    expect(await tracer.span("daemon.adapter.start", attributes, async () => "same-value", options)).toBe("same-value")
    expect(records.map(record => record.outcome)).toEqual(["error", "error", "ok"])
    expect(records[1].phases[0].outcome).toBe("error")
    expect(JSON.stringify(records)).not.toContain("private-start-error")
    await tracer.span("daemon.adapter.start", { ...attributes, "mikka.run.id_hash": "private-run" }, async () => 1, options)
    await tracer.span("daemon.adapter.start", { ...attributes, "mikka.harness": "private-harness" }, async () => 1, options)
    expect(records).toHaveLength(3)
  })

  it("keeps overlapping run scopes separate even when children finish in reverse order", async () => {
    const tracer = new DaemonTracer(), records: DaemonStartupTiming[] = []
    let releaseFirst!: () => void, releaseSecond!: () => void
    const firstReady = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondReady = new Promise<void>(resolve => { releaseSecond = resolve })
    const secondAttributes = { "mikka.run.id_hash": runIdHash("second-run"), "mikka.harness": "codex" }
    const options = { onStartupTiming: (timing: DaemonStartupTiming) => { records.push(timing) } }
    const first = tracer.span("daemon.adapter.start", attributes,
      () => tracer.span("daemon.adapter.auth.gate", attributes, () => firstReady), options)
    const second = tracer.span("daemon.adapter.start", secondAttributes,
      () => tracer.span("daemon.adapter.cli_init", secondAttributes, () => secondReady), options)
    releaseSecond(); await second
    releaseFirst(); await first
    expect(records.map(record => [record.harness, record.runIdHash, record.phases.map(phase => phase.name)])).toEqual([
      ["codex", secondAttributes["mikka.run.id_hash"], ["daemon.adapter.cli_init"]],
      ["claude_code", attributes["mikka.run.id_hash"], ["daemon.adapter.auth.gate"]],
    ])
  })

  it("keeps bound startup work out of foreign, closed, and unmeasured scopes", async () => {
    const tracer = new DaemonTracer(), records: DaemonStartupTiming[] = []
    const foreign = { "mikka.run.id_hash": runIdHash("foreign-run"), "mikka.harness": "codex" }
    const phase = (identity: Record<string, string>) =>
      tracer.span("daemon.adapter.auth.context", identity, async () => 42)
    const unmeasured = tracer.bindStartupTiming(phase)
    let bound = unmeasured
    const options = { onStartupTiming: (timing: DaemonStartupTiming) => records.push(timing) }
    await tracer.span("daemon.adapter.start", attributes, async () => {
      bound = tracer.bindStartupTiming(phase)
      expect(await bound(foreign)).toBe(42)
      expect(await bound(attributes)).toBe(42)
    }, options)
    const completed = JSON.stringify(records[0])
    await tracer.span("daemon.adapter.start", foreign, async () => {
      expect(await bound({})).toBe(42)
      expect(await unmeasured({})).toBe(42)
    }, options)
    expect(JSON.stringify(records[0])).toBe(completed)
    expect(records[0].phases.map(phase => phase.name)).toEqual(["daemon.adapter.auth.context"])
    expect(records[1]).toMatchObject({ runIdHash: foreign["mikka.run.id_hash"], harness: "codex", phases: [] })
    expect(tracer.headers()).toEqual({})
  })

  it("bounds records and closes the scope before detached CLI activity can append to it", async () => {
    const tracer = new DaemonTracer(), records: DaemonStartupTiming[] = []
    const options = { onStartupTiming: (timing: DaemonStartupTiming) => { records.push(timing) } }
    await tracer.span("daemon.adapter.start", attributes, async () => {
      for (let i = 0; i < STARTUP_TIMING_PHASE_LIMIT + 3; i++) await tracer.span("daemon.adapter.auth.gate", attributes, async () => i)
    }, options)
    expect(records[0].phases).toHaveLength(STARTUP_TIMING_PHASE_LIMIT)
    expect(records[0].truncated).toBe(true)
    let release!: () => void, detached!: Promise<unknown>
    const ready = new Promise<void>(resolve => { release = resolve })
    await tracer.span("daemon.adapter.start", attributes, async () => {
      detached = tracer.span("daemon.adapter.auth.context", attributes, async () => {
        await ready
        await tracer.span("daemon.adapter.auth.gate", attributes, async () => 1)
      })
    }, options)
    expect(records[1]).toMatchObject({ phases: [], truncated: true })
    const before = JSON.stringify(records)
    release(); await detached
    await tracer.span("daemon.adapter.auth.context", attributes, async () => 1)
    expect(JSON.stringify(records)).toBe(before)
  })
})
