import { expect, it } from "vitest"
import { OfficialCliTimingCollector, OFFICIAL_TIMING_EVENT_LIMIT, startCliTimingCollector } from "./official-cli-timing"
import { runRuntimeTimings } from "./run-runtime-timing"
import { runIdHash } from "./tracing"

const record = (values: Record<string, unknown>, timestamp = "1793980800000000000") => ({ timeUnixNano: timestamp,
  body: { stringValue: "PRIVATE_BODY" }, attributes: Object.entries(values).map(([key, value]) => ({ key,
    value: typeof value === "number" ? { doubleValue: value } : typeof value === "boolean" ? { boolValue: value } : { stringValue: value } })) })
const batch = (...records: unknown[]) => ({ resourceLogs: [{ resource: { attributes: [{ key: "user.email", value: { stringValue: "PRIVATE_EMAIL" } }] },
  scopeLogs: [{ scope: { name: "PRIVATE_SCOPE" }, logRecords: records }] }] })

it("keeps only closed official durations and metadata, never payloads or arbitrary model/error strings", () => {
  const collector = new OfficialCliTimingCollector("PRIVATE_RUN", "claude_code", () => 1000)
  expect(collector.accept(batch(record({ "event.name": "api_request", "event.sequence": 4, duration_ms: 1234,
    model: "claude-haiku-5-5", error: "PRIVATE_ERROR", url: "https://private.invalid", prompt: "PRIVATE_PROMPT", tool_name: "PRIVATE_TOOL" }),
  record({ "event.name": "tool_result", duration_ms: 30, success: "true" }, "1793980800000000001"),
  record({ "event.name": "api_error", duration_ms: 50, status_code: 429, attempt: 2, model: "PRIVATE_MODEL" }, "1793980800000000002")))).toBe(true)
  const receipt = collector.finish(true)
  expect(receipt).toMatchObject({ version: 1, runIdHash: runIdHash("PRIVATE_RUN"), harness: "claude_code", collection: "best_effort",
    cliExitObserved: true, flush: "not_confirmed", batches: 1, recordsReceived: 3, truncated: false, rejectedBatches: 0 })
  expect(receipt.events.map(event => [event.name, event.kind, event.durationMs, event.model, event.outcome])).toEqual([
    ["claude_code.api_request", "provider", 1234, "claude-haiku-5-5", "ok"], ["claude_code.tool_result", "tool", 30, null, "ok"],
    ["claude_code.api_error", "provider", 50, "other", "error"],
  ])
  expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|email|prompt|tool_name|url|https/)
  expect(collector.accept(batch(record({ "event.name": "api_request", duration_ms: 1 })))).toBe(false)
})

it("records Codex numeric strings, status and websocket requests without treating SSE output events as requests", () => {
  const collector = new OfficialCliTimingCollector("run", "codex")
  collector.accept(batch(record({ "event.name": "codex.api_request", duration_ms: "321", "http.response.status_code": 200, attempt: "1", model: "gpt-6-luna" }),
    record({ "event.name": "codex.websocket_request", duration_ms: "42", success: "false", "error.message": "PRIVATE" }),
    record({ "event.name": "codex.sse_event", duration_ms: "200", model: "PRIVATE" }),
    record({ "event.name": "claude_code.api_request", duration_ms: 50 })))
  const receipt = collector.finish()
  expect(receipt.events.map(event => [event.name, event.durationMs, event.status, event.attempt, event.outcome])).toEqual([
    ["codex.api_request", 321, 200, 1, "ok"], ["codex.websocket_request", 42, null, null, "error"],
  ])
  expect(receipt.ignoredRecords).toBe(2)
  expect(receipt.cliExitObserved).toBe(false)
  expect(JSON.stringify(receipt)).not.toContain("PRIVATE")
})

it("marks missing, malformed, truncated and duplicate evidence explicitly rather than claiming complete zero calls", () => {
  const empty = new OfficialCliTimingCollector("run", "codex").finish(true)
  expect(empty).toMatchObject({ events: [], collection: "best_effort", flush: "not_confirmed", cliExitObserved: true })
  const collector = new OfficialCliTimingCollector("run", "codex")
  expect(collector.accept({ PRIVATE: "body" })).toBe(false)
  collector.accept(batch(record({ "event.name": "codex.api_request", duration_ms: "PRIVATE" })))
  const first = record({ "event.name": "codex.api_request", duration_ms: 10 })
  collector.accept(batch(first, first))
  for (let i = 0; i < OFFICIAL_TIMING_EVENT_LIMIT; i++) collector.accept(batch(record({ "event.name": "codex.api_request", duration_ms: 20 }, String(1793980800000000001n + BigInt(i)))))
  const receipt = collector.finish()
  expect(receipt).toMatchObject({ rejectedBatches: 1, invalidEvents: 1, duplicates: 1, truncated: true })
  expect(receipt.events).toHaveLength(OFFICIAL_TIMING_EVENT_LIMIT)
  expect(JSON.stringify(receipt)).not.toContain("PRIVATE")
})

it("accepts a real loopback JSON export and attaches the bounded receipt to the existing runtime finish", async () => {
  const run = runRuntimeTimings.begin("official-receiver-test", "device", "codex")
  const receiver = await startCliTimingCollector({ runId: "official-receiver-test", harness: "codex" })
  try {
    expect(receiver.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/logs\/[a-f0-9]{32}$/)
    expect(receiver.args).toContain("otel.log_user_prompt=false")
    const response = await fetch(receiver.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(batch(record({ "event.name": "codex.api_request", duration_ms: "35", model: "gpt-6-luna" }))) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})
    await receiver.close({ cliExitObserved: true })
    const receipt = run.finish()!
    expect(receipt.officialCliTiming).toMatchObject({ runIdHash: runIdHash("official-receiver-test"), source: "official_cli_otlp",
      cliExitObserved: true, flush: "not_confirmed", events: [{ name: "codex.api_request", durationMs: 35 }] })
  } finally { await receiver.close(); run.close() }
})
