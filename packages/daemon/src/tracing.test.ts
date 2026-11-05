import { afterEach, describe, expect, it } from "vitest"
import { ExportResultCode } from "@opentelemetry/core"
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import { CodedError } from "@mikka/protocol/coded-error"
import { HttpServerLink } from "./server-link-http"
import { DaemonTracer, daemonSampleRate, daemonTracer, routeTemplate, runIdHash, SafeExporter, type TraceSettings } from "./tracing"

const settings: TraceSettings = { endpoint: "https://us.i.posthog.com/i/v1/traces", projectToken: "phc_testtoken123", sampleRate: 1, environment: "dev" }
const deviceId = "6f1c1f1e-3a5b-4c8d-9e0f-1a2b3c4d5e6f"

afterEach(async () => { await daemonTracer.shutdown() })

describe("daemon tracing", () => {
  it("exports only allowlisted, scrubbed attributes", async () => {
    const memory = new InMemorySpanExporter()
    const tracer = new DaemonTracer()
    expect(tracer.configure(settings, { exporter: memory, env: {} })).toBe(true)
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
    expect(Object.keys(span.attributes).sort()).toEqual(["mikka.client_kind", "mikka.error.detail", "mikka.harness", "mikka.outcome", "mikka.route", "mikka.run.id_hash"])
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
    tracer.configure(settings, { exporter: memory, env: {} })
    const error = new CodedError("subscription_local_runtime_unavailable", { detail: "adapter_start_failed", cause: new Error("spawn /Users/alex/.local/bin/claude ENOENT") })
    await expect(tracer.span("daemon.adapter.start", { "mikka.harness": "claude_code" }, async () => { throw error })).rejects.toBe(error)
    await tracer.flush()
    const [span] = memory.getFinishedSpans()
    expect(span.status.code).toBe(2)
    expect(span.status.message).toBeUndefined()
    expect(span.attributes["mikka.error.code"]).toBe("subscription_local_runtime_unavailable")
    expect(span.attributes["mikka.error.detail"]).toBe("adapter_start_failed")
    expect(span.attributes["mikka.outcome"]).toBe("error")
    expect(JSON.stringify(span.attributes)).not.toContain("alex")
    await tracer.shutdown()
  })

  it("joins /v1 calls to the active span with a traceparent the server continues", async () => {
    const memory = new InMemorySpanExporter()
    daemonTracer.configure(settings, { exporter: memory, env: {} })
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
      tracer.configure(settings, { exporter, env: {} })
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
