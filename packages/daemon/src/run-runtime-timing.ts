import { AsyncLocalStorage } from "node:async_hooks"
import { HARNESSES, type Harness } from "@mikka/protocol/harness"
import { runIdHash } from "./tracing"
import type { OfficialCliTiming } from "./official-cli-timing"

type Phase = "preparing" | "executing" | "finishing"
type Endpoint = "policy_snapshot" | "permission_check" | "permission_request" | "server_decision" | "computer_authority"
  | "subscription_context" | "provider_proxy" | "credential_lease" | "credential_refresh"
  | "github_credential_lease" | "github_credential_refresh"
  | "run_telemetry" | "device_control" | "run_control" | "task_data" | "mailbox_operation" | "storage_transfer" | "other_run_request"
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "HEAD" | "OPTIONS" | "other"
type Outcome = "ok" | "error" | "pending"
type AgentAcceptedKind = "claude_user_ack" | "claude_system_init" | "claude_first_event" | "codex_turn_start_ack"
type RequestRecord = { sequence: number; endpoint: Endpoint; phase: Phase; method: Method; shared: boolean
  startMs: number; endMs: number | null; ms: number | null; outcome: Outcome }
type Count = { endpoint: Endpoint; phase: Phase; shared: boolean; started: number; completed: number; errors: number; ms: number }

/** A receipt of actual Mikka HTTP sends, not sampled spans or inferred calls.
 * Provider CLI traffic goes directly to the provider and is not measured here.
 * The final receipt rides the run's existing finish chunk; no extra write. */
export type RunRuntimeTiming = {
  version: 1
  runIdHash: string
  harness: Harness
  source: "http_server_link"
  window: "run_launch_to_agent_exit"
  startedAt: number
  endedAt: number
  ms: number
  executionStartMs: number | null
  executionEndMs: number | null
  agentAccepted?: { kind: AgentAcceptedKind; at: number; ms: number }
  complete: boolean
  requests: RequestRecord[]
  counts: Count[]
  truncated: boolean
  providerOutputChunks: number
  toolCallsStarted: number
  toolCallsCompleted: number
  toolCallsFailed: number
  officialCliTiming?: OfficialCliTiming
}

export const RUNTIME_REQUEST_LIMIT = 128
const TOOL_LIMIT = 256
const METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"])
const ms = (value: number) => Math.max(0, Math.round(value * 1_000) / 1_000)
const NOOP = () => {}

function classify(tail: string, body: unknown): Endpoint {
  const operation = body && typeof body === "object" ? body as { action?: unknown; operation?: unknown } : undefined
  if (tail === "policy-snapshot") return "policy_snapshot"
  if (tail === "tool-approval") return operation?.operation === "check" ? "permission_check" : "permission_request"
  if (tail === "decision") return "server_decision"
  if (tail === "computer-authority") return "computer_authority"
  if (tail === "skill-receipt") return "permission_check"
  if (tail === "subscription") return operation?.action === "context" ? "subscription_context"
    : operation?.action === "request" ? "provider_proxy" : "other_run_request"
  if (tail === "subscription-lease") return "credential_lease"
  if (["", "events", "checkpoint", "complete"].includes(tail)) return "run_telemetry"
  if (["claim", "commands"].includes(tail)) return "run_control"
  if (/^(attachments|captures)(\/|$)/.test(tail)) return "task_data"
  return "other_run_request"
}

export class RunRuntimeObservation {
  private readonly started: number
  private readonly startedAt: number
  private phase: Phase = "preparing"
  private executionStartMs: number | null = null
  private executionEndMs: number | null = null
  private agentAccepted?: { kind: AgentAcceptedKind; at: number; ms: number }
  private readonly requests: RequestRecord[] = []
  private readonly counts = new Map<string, Count>()
  private sequence = 0
  private truncated = false
  private closed = false
  private providerOutputChunks = 0
  private readonly tools = new Set<string>()
  private readonly completedTools = new Set<string>()
  private toolCallsFailed = 0
  private officialCliTiming?: OfficialCliTiming

  constructor(readonly hash: string, readonly deviceHash: string, readonly harness: Harness,
    private readonly release: () => void, private readonly clock: () => number, private readonly wallClock: () => number) {
    this.started = clock(); this.startedAt = wallClock()
  }

  executing() {
    if (this.closed || this.phase !== "preparing") return
    this.phase = "executing"; this.executionStartMs = ms(this.clock() - this.started)
  }
  finishing() {
    if (this.closed || this.phase === "finishing") return
    if (this.phase === "executing") this.executionEndMs = ms(this.clock() - this.started)
    this.phase = "finishing"
  }

  attachOfficialCliTiming(timing: OfficialCliTiming) {
    if (!this.closed && timing.runIdHash === this.hash && timing.harness === this.harness) this.officialCliTiming = timing
  }

  accepted(kind: AgentAcceptedKind) {
    if (this.closed || this.agentAccepted || !(this.harness === "claude_code" ? ["claude_user_ack", "claude_system_init", "claude_first_event"].includes(kind)
      : this.harness === "codex" && kind === "codex_turn_start_ack")) return
    this.agentAccepted = { kind, at: this.wallClock(), ms: ms(this.clock() - this.started) }
  }

  /** Receives existing UI chunks. Only counts and hashed tool ids stay in memory. */
  chunk(chunk: { type: string; [key: string]: unknown }) {
    if (this.closed) return
    if (["text-delta", "reasoning-delta"].includes(chunk.type) && typeof chunk.delta === "string" && chunk.delta.length > 0) this.providerOutputChunks++
    if (!["tool-input-start", "tool-input-available", "tool-output-available", "tool-output-error"].includes(chunk.type)) return
    if (typeof chunk.toolCallId !== "string" || !chunk.toolCallId || chunk.toolCallId.length > 512) { this.truncated = true; return }
    const hash = runIdHash(chunk.toolCallId)
    if (chunk.type.startsWith("tool-input-")) {
      if (this.tools.size < TOOL_LIMIT) this.tools.add(hash)
      else if (!this.tools.has(hash)) this.truncated = true
    } else if (this.tools.has(hash) && !this.completedTools.has(hash)) {
      this.completedTools.add(hash)
      if (chunk.type === "tool-output-error") this.toolCallsFailed++
    }
  }

  request(endpoint: Endpoint, method: Method, shared: boolean) {
    if (this.closed) return NOOP
    const started = this.clock(), phase = this.phase, key = `${phase}:${endpoint}:${shared}`
    let count = this.counts.get(key)
    if (!count) { count = { endpoint, phase, shared, started: 0, completed: 0, errors: 0, ms: 0 }; this.counts.set(key, count) }
    count.started++
    const record: RequestRecord = { sequence: ++this.sequence, endpoint, phase, method, shared,
      startMs: ms(started - this.started), endMs: null, ms: null, outcome: "pending" }
    if (this.requests.length < RUNTIME_REQUEST_LIMIT) this.requests.push(record)
    else this.truncated = true
    let done = false
    return (status?: number) => {
      if (done || this.closed) return
      done = true
      const ended = this.clock(), duration = ms(ended - started)
      const ok = status !== undefined && status >= 200 && status < 300
      count.completed++; count.ms = ms(count.ms + duration); if (!ok) count.errors++
      record.endMs = ms(ended - this.started); record.ms = duration; record.outcome = ok ? "ok" : "error"
    }
  }

  finish(): RunRuntimeTiming | undefined {
    if (this.closed) return
    this.finishing()
    const receipt: RunRuntimeTiming = { version: 1, runIdHash: this.hash, harness: this.harness, source: "http_server_link",
      window: "run_launch_to_agent_exit", startedAt: this.startedAt, endedAt: this.wallClock(), ms: ms(this.clock() - this.started),
      executionStartMs: this.executionStartMs, executionEndMs: this.executionEndMs, complete: true,
      ...(this.agentAccepted ? { agentAccepted: { ...this.agentAccepted } } : {}),
      requests: this.requests.map(record => ({ ...record })), counts: [...this.counts.values()].map(count => ({ ...count })), truncated: this.truncated,
      providerOutputChunks: this.providerOutputChunks, toolCallsStarted: this.tools.size, toolCallsCompleted: this.completedTools.size, toolCallsFailed: this.toolCallsFailed,
      ...(this.officialCliTiming ? { officialCliTiming: this.officialCliTiming } : {}) }
    this.close()
    return receipt
  }

  close() {
    if (this.closed) return
    this.closed = true; this.release()
    this.requests.length = 0; this.counts.clear(); this.tools.clear(); this.completedTools.clear()
  }
}

/** Keyed by the actual run in the transport path, so gateway-triggered work
 * outside the run's async context is still counted. Device heartbeats are
 * explicitly shared and do not become per-operation permission checks. */
export class RunRuntimeTimings {
  private readonly runs = new Map<string, RunRuntimeObservation>()
  private readonly refresh = new AsyncLocalStorage<string>()
  constructor(private readonly clock: () => number = () => performance.now(), private readonly wallClock: () => number = Date.now) {}

  begin(runId: string, deviceId: string, harness: Harness): RunRuntimeObservation {
    const hash = runIdHash(runId)
    if (!HARNESSES.includes(harness)) throw new TypeError("Invalid timing harness")
    this.runs.get(hash)?.close()
    const observation = new RunRuntimeObservation(hash, runIdHash(deviceId), harness, () => {
      if (this.runs.get(hash) === observation) this.runs.delete(hash)
    }, this.clock, this.wallClock)
    this.runs.set(hash, observation)
    return observation
  }

  /** Only wrap the actual token-expiry background renewal, never a tool call. */
  backgroundCredentialRefresh<T>(runId: string, work: () => Promise<T>): Promise<T> {
    return this.refresh.run(runIdHash(runId), work)
  }

  attachOfficialCliTiming(runId: string, timing: OfficialCliTiming) {
    this.runs.get(runIdHash(runId))?.attachOfficialCliTiming(timing)
  }

  agentAccepted(runId: string, kind: AgentAcceptedKind) {
    this.runs.get(runIdHash(runId))?.accepted(kind)
  }

  /** Already-authorized task transports whose URL does not contain the run.
   * Only the caller's held assignment supplies identity; never infer it from
   * payloads, signed storage URLs, or MCP arguments. */
  taskRequest(runId: string, endpoint: "mailbox_operation" | "storage_transfer" | "task_data", method: string): (status?: number) => void {
    try {
      const verb: Method = METHODS.has(method) ? method as Method : "other"
      return this.runs.get(runIdHash(runId))?.request(endpoint, verb, false) ?? NOOP
    } catch { return NOOP }
  }

  request(method: string, path: string, body: unknown): (status?: number) => void {
    try {
      const clean = path.split(/[?#]/, 1)[0]
      const deviceRun = /^\/v1\/devices\/([^/]+)\/runs\/([^/]+)(?:\/(.*))?$/.exec(clean)
      const run = /^\/v1\/runs\/([^/]+)(?:\/(.*))?$/.exec(clean)
      const verb: Method = METHODS.has(method) ? method as Method : "other"
      if (deviceRun || run) {
        const hash = runIdHash(decodeURIComponent(deviceRun ? deviceRun[2] : run![1]))
        const observation = this.runs.get(hash)
        if (!observation || (deviceRun && observation.deviceHash !== runIdHash(decodeURIComponent(deviceRun[1])))) return NOOP
        let endpoint = classify((deviceRun ? deviceRun[3] : run![2]) ?? "", body)
        if (endpoint === "credential_lease" && this.refresh.getStore() === hash) endpoint = "credential_refresh"
        return observation.request(endpoint, verb, false)
      }
      const github = /^\/v1\/devices\/([^/]+)\/github-token$/.exec(clean)
      if (github) {
        const query = new URL(path, "http://localhost").searchParams
        const runId = query.get("runId")
        if (!runId || query.getAll("runId").length !== 1) return NOOP
        const hash = runIdHash(runId), observation = this.runs.get(hash)
        if (!observation || observation.deviceHash !== runIdHash(decodeURIComponent(github[1]))) return NOOP
        return observation.request(this.refresh.getStore() === hash ? "github_credential_refresh" : "github_credential_lease", verb, false)
      }
      const device = /^\/v1\/devices\/([^/]+)\/(heartbeat|gateway|commands|runs)$/.exec(clean)
      if (!device) return NOOP
      const hash = runIdHash(decodeURIComponent(device[1]))
      const pending = [...this.runs.values()].filter(observation => observation.deviceHash === hash)
        .map(observation => observation.request("device_control", verb, true))
      return status => { for (const done of pending) done(status) }
    } catch { return NOOP /* Measurement never changes transport behavior. */ }
  }
}

export const runRuntimeTimings = new RunRuntimeTimings()
