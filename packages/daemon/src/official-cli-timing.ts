import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { runIdHash } from "./tracing"
import { runRuntimeTimings } from "./run-runtime-timing"
import { McpHttpTimingCollector, MCP_HTTP_BODY_LIMIT } from './mcp-http-timing'

type Harness = "claude_code" | "codex"
type EventName = "claude_code.api_request" | "claude_code.api_error" | "claude_code.tool_result"
  | "codex.api_request" | "codex.websocket_request" | "codex.tool_result"
type Model = "claude-haiku-5-5" | "gpt-6-luna" | "other"
type TimingEvent = { name: EventName; kind: "provider" | "tool"; receivedAt: number; eventAt: number | null
  durationMs: number; model: Model | null; outcome: "ok" | "error" | "unknown"; status: number | null
  attempt: number | null; sequence: number | null }

/** Official exporters are best effort. Neither an empty collection nor a
 * normal CLI exit proves that the exporter flushed every request. The actual
 * host HTTP receipt independently covers HttpServerLink and taskFetch sends.
 * Child business requests have a separate, explicitly observed-only receipt. */
export type OfficialCliTiming = {
  version: 1; source: "official_cli_otlp"; runIdHash: string; harness: Harness
  startedAt: number; endedAt: number; collection: "best_effort"; flush: "not_confirmed"
  cliExitObserved: boolean; batches: number; recordsReceived: number; duplicates: number
  rejectedBatches: number; invalidEvents: number; ignoredRecords: number; truncated: boolean; events: TimingEvent[]
}

export const OFFICIAL_TIMING_EVENT_LIMIT = 256
export const OFFICIAL_TIMING_BODY_LIMIT = 1_048_576
const EVENTS = new Set<EventName>(["claude_code.api_request", "claude_code.api_error", "claude_code.tool_result",
  "codex.api_request", "codex.websocket_request", "codex.tool_result"])
const KEYS = new Set(["event.name", "event.timestamp", "event.sequence", "duration_ms", "model", "success",
  "status_code", "http.response.status_code", "attempt"])
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined
const number = (value: unknown, max: number): number | null => {
  const candidate = typeof value === "number" ? value : typeof value === "string" && /^\d{1,16}(?:\.\d{1,6})?$/.test(value) ? Number(value) : NaN
  return Number.isFinite(candidate) && candidate >= 0 && candidate <= max ? candidate : null
}
function scalar(value: unknown): string | number | boolean | undefined {
  const item = object(value)
  if (typeof item?.stringValue === "string") return item.stringValue
  if (typeof item?.boolValue === "boolean") return item.boolValue
  if (typeof item?.intValue === "number" || typeof item?.intValue === "string") return item.intValue
  if (typeof item?.doubleValue === "number") return item.doubleValue
}

/** Immediately project incoming OTLP into closed numeric fields. Resource,
 * body, URLs, errors, prompts, tool details and arbitrary attributes are never
 * retained, logged or sent on. Both official CLIs support OTLP HTTP/JSON. */
export class OfficialCliTimingCollector {
  private readonly startedAt: number
  private batches = 0
  private recordsReceived = 0
  private rejectedBatches = 0
  private invalidEvents = 0
  private ignoredRecords = 0
  private duplicates = 0
  private truncated = false
  private readonly events: TimingEvent[] = []
  private readonly seen = new Set<string>()
  private closed = false
  constructor(readonly runId: string, readonly harness: Harness, private readonly now: () => number = Date.now) { this.startedAt = now() }

  reject() { if (!this.closed) this.rejectedBatches++ }
  truncate() { if (!this.closed) this.truncated = true }

  accept(input: unknown): boolean {
    if (this.closed) return false
    const resources = object(input)?.resourceLogs
    if (!Array.isArray(resources)) { this.reject(); return false }
    this.batches++
    for (const resource of resources) {
      const scopes = object(resource)?.scopeLogs
      if (!Array.isArray(scopes)) { this.reject(); continue }
      for (const scope of scopes) {
        const records = object(scope)?.logRecords
        if (!Array.isArray(records)) { this.reject(); continue }
        for (const raw of records) this.record(raw)
      }
    }
    return true
  }

  private record(raw: unknown) {
    this.recordsReceived++
    const record = object(raw), attributes = record?.attributes, fields: Record<string, unknown> = {}
    if (!Array.isArray(attributes) || attributes.length > 128) { this.invalidEvents++; return }
    for (const rawAttribute of attributes) {
      const attribute = object(rawAttribute)
      if (typeof attribute?.key === "string" && KEYS.has(attribute.key)) fields[attribute.key] = scalar(attribute.value)
    }
    const rawName = fields["event.name"]
    const candidate = typeof rawName === "string" && this.harness === "claude_code" && !rawName.startsWith("claude_code.")
      ? `claude_code.${rawName}` : rawName
    if (typeof candidate !== "string" || !EVENTS.has(candidate as EventName) || !candidate.startsWith(`${this.harness}.`)) { this.ignoredRecords++; return }
    const name = candidate as EventName, durationMs = number(fields.duration_ms, 86_400_000)
    if (durationMs === null) { this.invalidEvents++; return }
    const nanos = typeof record?.timeUnixNano === "string" && /^\d{1,20}$/.test(record.timeUnixNano) ? record.timeUnixNano : null
    const timestamp = typeof fields["event.timestamp"] === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(fields["event.timestamp"])
      ? Date.parse(fields["event.timestamp"]) : NaN
    const eventAt = Number.isFinite(timestamp) ? timestamp : nanos ? Number(nanos) / 1_000_000 : null
    const sequence = number(fields["event.sequence"], Number.MAX_SAFE_INTEGER)
    const identity = nanos || sequence !== null ? `${name}:${nanos}:${sequence}` : null
    if (identity && this.seen.has(identity)) { this.duplicates++; return }
    if (this.events.length >= OFFICIAL_TIMING_EVENT_LIMIT) { this.truncated = true; return }
    if (identity) this.seen.add(identity)
    const numericStatus = number(fields["http.response.status_code"] ?? fields.status_code, 599)
    const status = numericStatus !== null && Number.isInteger(numericStatus) && numericStatus >= 100 ? numericStatus : null
    const success = fields.success
    const outcome = name === "claude_code.api_error" || success === false || success === "false" || (status !== null && status >= 400)
      ? "error" : name === "claude_code.api_request" || success === true || success === "true" || (status !== null && status >= 200 && status < 300) ? "ok" : "unknown"
    const model: Model | null = fields.model === undefined ? null : fields.model === "claude-haiku-5-5" || fields.model === "gpt-6-luna" ? fields.model : "other"
    this.events.push({ name, kind: name.endsWith(".tool_result") ? "tool" : "provider", receivedAt: this.now(), eventAt,
      durationMs, model, outcome, status, attempt: number(fields.attempt, 1000), sequence })
  }

  finish(cliExitObserved = false): OfficialCliTiming {
    this.closed = true
    return { version: 1, source: "official_cli_otlp", runIdHash: runIdHash(this.runId), harness: this.harness,
      startedAt: this.startedAt, endedAt: this.now(), collection: "best_effort", flush: "not_confirmed", cliExitObserved,
      batches: this.batches, recordsReceived: this.recordsReceived, duplicates: this.duplicates, rejectedBatches: this.rejectedBatches,
      invalidEvents: this.invalidEvents, ignoredRecords: this.ignoredRecords, truncated: this.truncated, events: this.events.map(event => ({ ...event })) }
  }
}

/** Called by a trusted cloud host or an explicitly configured diagnostic task. The receiver is
 * loopback-only and adds no remote I/O or provider interception. Configuration
 * is per child process; no official CLI file or config file is modified.
 * Sources: code.claude.com/docs/en/monitoring-usage and
 * openai/codex/codex-rs/otel/{src/config.rs,src/provider.rs,README.md}. */
export async function startCliTimingCollector({ runId, harness, remoteMcpServerCount }: {
  runId: string; harness: Harness; model?: string; remoteMcpServerCount: number
}) {
  const collector = new OfficialCliTimingCollector(runId, harness)
  const mcpCollector = new McpHttpTimingCollector(runId, harness, remoteMcpServerCount)
  const path = `/v1/logs/${randomBytes(16).toString("hex")}`
  const mcpPath = `/v1/mcp-http/${randomBytes(16).toString('hex')}`
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const target = request.url === mcpPath ? mcpCollector : collector
    const limit = request.url === mcpPath ? MCP_HTTP_BODY_LIMIT : OFFICIAL_TIMING_BODY_LIMIT
    if (request.method !== "POST" || ![path, mcpPath].includes(request.url ?? '') || !/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")
      || (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")) {
      target.reject(); response.writeHead(400).end(); request.resume(); return
    }
    void (async () => {
      let bytes = 0
      const chunks: Buffer[] = []
      try {
        for await (const chunk of request) {
          bytes += chunk.length
          if (bytes > limit) { target.reject(); target.truncate(); response.writeHead(413).end(); request.destroy(); return }
          chunks.push(chunk)
        }
        const accepted = target.accept(JSON.parse(Buffer.concat(chunks).toString("utf8")))
        response.writeHead(accepted ? 200 : 400, { "content-type": "application/json" }).end("{}")
      } catch { target.reject(); if (!response.writableEnded) response.writeHead(400).end() }
      finally { chunks.length = 0 }
    })()
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.maxConnections = 8
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve() })
  })
  server.on("error", () => { collector.reject(); mcpCollector.reject() })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const endpoint = `${origin}${path}`
  // Codex requires compression unset; preserve the validated Claude configuration.
  const env: Record<string, string> = {
    OTEL_METRICS_EXPORTER: "none", OTEL_TRACES_EXPORTER: "none", OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: "", OTEL_EXPORTER_OTLP_HEADERS: "",
    ...(harness === "claude_code" ? { OTEL_EXPORTER_OTLP_LOGS_COMPRESSION: "none" } : {}),
    OTEL_LOGS_EXPORT_INTERVAL: "1000", OTEL_BLRP_SCHEDULE_DELAY: "1000",
    OTEL_LOG_USER_PROMPTS: "0", OTEL_LOG_ASSISTANT_RESPONSES: "0", OTEL_LOG_TOOL_DETAILS: "0", OTEL_LOG_TOOL_CONTENT: "0", OTEL_LOG_RAW_API_BODIES: "0",
    ...(harness === "claude_code" ? { CLAUDE_CODE_ENABLE_TELEMETRY: "1" } : {}),
  }
  const args = harness === "codex" ? ["-c", `otel.exporter={otlp-http={endpoint=${JSON.stringify(endpoint)},protocol="json",headers={}}}`,
    "-c", "otel.trace_exporter=\"none\"", "-c", "otel.metrics_exporter=\"none\"", "-c", "otel.log_user_prompt=false",
    "-c", "otel.log_agent_responses=false", "-c", "otel.log_guardian_assessments=false"] : []
  // Rust OTLP accepts only gzip/zstd strings; both env fallbacks must be absent
  // for its default uncompressed JSON. Apply after merging the machine env.
  const unsetEnv = harness === "codex"
    ? ["OTEL_EXPORTER_OTLP_LOGS_COMPRESSION", "OTEL_EXPORTER_OTLP_COMPRESSION"] : []
  let closed: Promise<void> | undefined
  // Only the Mikka MCP child's private environment receives this URL. It is
  // not an authorization token and is never placed in the task or CLI env.
  return { env, args, unsetEnv, mcpHttpObservationUrl: `${origin}${mcpPath}`,
    close: ({ cliExitObserved = false }: { cliExitObserved?: boolean } = {}) => closed ??= (async () => {
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { collector.truncate(); mcpCollector.truncate(); server.closeAllConnections() }, 1000)
      server.close(() => { clearTimeout(timer); resolve() })
    })
    runRuntimeTimings.attachOfficialCliTiming(runId, collector.finish(cliExitObserved))
    runRuntimeTimings.attachMcpHttpTiming(runId, mcpCollector.finish())
  })() }
}
