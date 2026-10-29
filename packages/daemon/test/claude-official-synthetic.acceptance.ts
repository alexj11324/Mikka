// Opt-in diagnostic: locked official Claude SDK/CLI, actual ClaudeAdapter and
// per-run SRT launcher, and a synthetic loopback Anthropic Messages provider.
// No account, real credentials, real provider, inference, install or push.
// This establishes transport/tool-gate behavior only, not product acceptance.
// Every temporary directory and log is retained; only owned listeners/processes
// close at the end. A requested run fails on missing prerequisites or evidence.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { gunzipSync } from "node:zlib"

import { beforeAll, describe, expect, it } from "vitest"

import { ClaudeAdapter } from "../src/adapters/claude"
import type { AgentEvent, AgentSession } from "../src/adapters/types"
import { SandboxRuntime, shellJoin, shellQuote } from "../src/agents/sandbox"
import { ToolApprovalGate, type ToolApprovalRequest } from "../src/agents/tool-approval"
import { toolApprovalDecision } from "../src/agents/tool-approval-policy"
import { ComputerBroker } from "../src/computer/broker.mjs"
import { createLogger } from "../src/log"
import { runPolicy, type RunPolicy } from "../src/permissions"
import { makeRepo, waitFor } from "./helpers"

const enabled = process.env.MIKKA_SANDBOX_ACCEPTANCE === "1"
const SDK_VERSION = "0.3.305"
const CLI_VERSION = "2.1.305"
const MODEL = "claude-sonnet-4-6" // Schema selector for a local canned response.
const KEY = "synthetic-loopback-fixture-no-provider-credential"
const CALL_ID = "toolu_synthetic_official_claude_probe"
const CONTENT = "official-claude-write-completed\n"
const COMPUTER_TOOL = "mcp__mikka_computer__get_desktop_state"
const COMPUTER_RESULT = "synthetic-official-cli-computer-proxy-result"

type JsonObject = Record<string, unknown>
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function deadline<T>(promise: Promise<T>, label: string, ms = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    })])
  } finally { clearTimeout(timer) }
}

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const sockets = new Set<Socket>()
  const http = createServer(handler)
  http.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject)
    http.listen(0, "127.0.0.1", resolve)
  })
  const address = http.address()
  if (!address || typeof address === "string") throw new Error("missing fixture address")
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

// These are genuine Anthropic wire events. No SDK query/control stream or
// canUseTool callback is substituted or invoked by this fixture.
function messagesSse(response: ServerResponse, content: JsonObject, tool: boolean) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const emit = (type: string, payload: JsonObject = {}) => response.write(
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`,
  )
  emit("message_start", { message: {
    id: tool ? "msg_synthetic_tool" : "msg_synthetic_final",
    type: "message", role: "assistant", model: MODEL, content: [],
    stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  } })
  emit("content_block_start", { index: 0, content_block: tool
    ? { type: "tool_use", id: CALL_ID, name: content.name, input: {} }
    : { type: "text", text: "" } })
  emit("content_block_delta", { index: 0, delta: tool
    ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) }
    : { type: "text_delta", text: content.text } })
  emit("content_block_stop", { index: 0 })
  emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
  emit("message_stop")
  response.end()
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 2_000_000) throw new Error("fixture request too large")
    chunks.push(Buffer.from(chunk))
  }
  let body = Buffer.concat(chunks)
  if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body, { maxOutputLength: 2_000_000 })
  else if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw new Error("unsupported fixture request encoding")
  const parsed: unknown = JSON.parse(body.toString())
  if (!object(parsed)) throw new Error("invalid Messages request")
  return parsed
}

function resultBlock(input: JsonObject): JsonObject | undefined {
  if (!Array.isArray(input.messages)) return
  for (const message of input.messages) {
    if (!object(message) || message.role !== "user" || !Array.isArray(message.content)) continue
    const found = message.content.find((block: unknown) => object(block) && block.type === "tool_result" && block.tool_use_id === CALL_ID)
    if (object(found)) return found
  }
}

async function provider(toolName: "Write" | "Bash" | typeof COMPUTER_TOOL, toolInput: JsonObject, unavailable: boolean) {
  const requests: { route: string; body: JsonObject }[] = []
  const failures: string[] = []
  const toolOutput = deferred<JsonObject>()
  let toolSent = false
  let finalSent = false
  const listening = await server((request, response) => {
    void (async () => {
      const route = new URL(request.url ?? "/", "http://fixture.invalid").pathname
      if (request.method !== "POST" || !["/v1/messages", "/v1/messages/count_tokens"].includes(route)) {
        throw new Error(`unexpected fixture route: ${request.method} ${route}`)
      }
      if (request.headers["x-api-key"] !== KEY) throw new Error("synthetic fixture key mismatch")
      const input = await readJson(request)
      requests.push({ route, body: input })
      if (requests.length > 8) throw new Error("unexpected extra Messages requests")
      if (route === "/v1/messages/count_tokens") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ input_tokens: 1 }))
        return
      }
      if (input.model !== MODEL || input.stream !== true) throw new Error("unexpected model or non-streaming fixture request")
      const result = resultBlock(input)
      if (result) {
        if (!toolSent || finalSent) throw new Error("unexpected/repeated tool result")
        finalSent = true
        toolOutput.resolve(result)
        messagesSse(response, { text: "Synthetic official CLI diagnostic complete." }, false)
        return
      }
      if (toolSent) throw new Error("official CLI did not return the requested tool result")
      const tools = Array.isArray(input.tools) ? input.tools.filter(object) : []
      if (!unavailable && !tools.some((tool) => tool.name === toolName)) throw new Error(`official CLI did not advertise ${toolName}`)
      // A forced restricted Bash call is a negative control. Deny rules may
      // either omit it from the advertised schema or reject it at dispatch.
      toolSent = true
      messagesSse(response, { name: toolName, input: toolInput }, true)
    })().catch((error: unknown) => {
      failures.push(String(error))
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ type: "error", error: { type: "fixture_error", message: String(error) } }))
    })
  })
  return { ...listening, requests, failures, toolOutput }
}

interface OfficialRuntime {
  binary: string
  sdkEntry: string
  sdkVersion: string
  cliVersion: string
  binarySha256: string
}

function officialRuntime(): OfficialRuntime {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("this diagnostic requires Linux x64 with the locked glibc native CLI")
  const require = createRequire(import.meta.url)
  const sdkEntry = realpathSync(require.resolve("@anthropic-ai/claude-agent-sdk"))
  const sdk: unknown = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf8"))
  if (!object(sdk) || sdk.name !== "@anthropic-ai/claude-agent-sdk" || sdk.version !== SDK_VERSION || sdk.claudeCodeVersion !== CLI_VERSION) {
    throw new Error(`requires locked official SDK ${SDK_VERSION} / Claude CLI ${CLI_VERSION}`)
  }
  const sdkRequire = createRequire(sdkEntry)
  const binary = realpathSync(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude"))
  const native: unknown = JSON.parse(readFileSync(join(dirname(binary), "package.json"), "utf8"))
  if (!object(native) || native.name !== "@anthropic-ai/claude-agent-sdk-linux-x64" || native.version !== SDK_VERSION) {
    throw new Error("official native CLI package is missing or not locked to the SDK")
  }
  // Do not launch even a --version subprocess outside the real SRT boundary.
  return { binary, sdkEntry, sdkVersion: SDK_VERSION, cliVersion: CLI_VERSION, binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex") }
}

function wrapper(dir: string, binary: string, stderrPath: string) {
  const path = join(dir, "official-claude-wrapper.sh")
  // This wrapper only execs the installed official binary. The CLI provider
  // connection must traverse SRT's authenticated proxy even for loopback.
  writeFileSync(path, `#!/bin/sh\nexport NO_PROXY='' no_proxy=''\nexec ${shellQuote(binary)} "$@" 2>>${shellQuote(stderrPath)}\n`, { mode: 0o700 })
  return path
}

const PROBE = String.raw`
const http = require('node:http');
const fs = require('node:fs');
const proxy = new URL(process.env.HTTP_PROXY);
fs.writeFileSync(process.argv[3], 'official-claude-bash-ran');
const request = http.request({
  hostname:proxy.hostname, port:proxy.port, path:process.argv[2], agent:false,
  headers:{'proxy-authorization':'Basic '+Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64')},
}, response => {
  let body=''; response.on('data', chunk => body+=chunk);
  response.on('end', () => {
    console.log(JSON.stringify({status:response.statusCode,body}));
    process.exitCode=response.statusCode===200?0:7;
  });
});
request.on('error', error => {console.log(JSON.stringify({error:error.code}));process.exitCode=8;});
request.setTimeout(20000, () => request.destroy(new Error('fixture deadline')));
request.end();
`

// Parse observation data only; command strings never confer authorization.
function probeResult(value: unknown, depth = 0): { status: number; body: string } | undefined {
  if (depth > 10) return
  if (object(value)) {
    if (Number.isInteger(value.status) && typeof value.body === "string") return value as { status: number; body: string }
    for (const item of Object.values(value)) { const found = probeResult(item, depth + 1); if (found) return found }
  } else if (Array.isArray(value)) {
    for (const item of value) { const found = probeResult(item, depth + 1); if (found) return found }
  } else if (typeof value === "string") {
    for (const line of value.split("\n")) {
      try {
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed !== "string") { const found = probeResult(parsed, depth + 1); if (found) return found }
      } catch { /* CLI tool output can include non-JSON decoration. */ }
    }
  }
}

type Scenario = "write-allow" | "network-allow" | "network-ask-allow" | "network-ask-deny" | "network-cancel" | "network-outside-ceiling" | "bash-restricted"

async function diagnostic(runtime: OfficialRuntime, scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), "mikka-official-claude-synthetic-"))
  const cwd = await makeRepo()
  console.info(`Retained official Claude synthetic diagnostic: ${dir}; worktree: ${cwd}`)
  const hits: string[] = []
  const approvals: ToolApprovalRequest[] = []
  const asks: ToolApprovalRequest[] = []
  const decisions: { requestId: string; decision: string }[] = []
  const events: AgentEvent[] = []
  const cleanupErrors: string[] = []
  const asked = deferred<AbortSignal>()
  const release = deferred<"allow" | "deny">()
  const runId = "official-claude-synthetic-run"
  const marker = join(cwd, "official-claude-marker")
  const probe = join(cwd, "synthetic-proxy-probe.cjs")
  const write = scenario === "write-allow"
  const restricted = scenario === "bash-restricted"
  const policy: RunPolicy = runPolicy(undefined)
  policy.networkAllow = []
  policy.permissions.network = scenario === "network-allow" ? "allow" : "ask"
  if (!write && !restricted) {
    // Native Bash is authorized as a whole by the actual production mapping.
    // These flags never execute an installation or push in this fixture.
    policy.permissions.install_dependency = "allow"
    policy.permissions.git_push = "allow"
  }
  let origin: Awaited<ReturnType<typeof server>> | undefined
  let synthetic: Awaited<ReturnType<typeof provider>> | undefined
  let session: AgentSession | undefined
  let finished: Promise<void> | undefined
  let gate: ToolApprovalGate | undefined
  let networkCeiling: readonly string[] = []
  let failure: string | undefined
  try {
    origin = await server((request, response) => {
      hits.push(request.url ?? "")
      if (request.method !== "GET" || request.url !== "/probe") { response.writeHead(400).end(); return }
      response.end("synthetic-origin-ok")
    })
    writeFileSync(probe, PROBE)
    const command = shellJoin([process.execPath, probe, `${origin.url}/probe`, marker])
    const toolInput = write ? { file_path: marker, content: CONTENT } : { command, timeout: 25000, description: "Synthetic loopback diagnostic" }
    synthetic = await provider(write ? "Write" : "Bash", toolInput, restricted)
    const providerPort = synthetic.port
    const originPort = origin.port
    networkCeiling = Object.freeze([
      `127.0.0.1:${providerPort}`,
      ...(scenario === "network-outside-ceiling" ? [] : [`127.0.0.1:${originPort}`]),
    ])
    gate = new ToolApprovalGate(runId, {
      isLive: (id) => id === runId,
      permission(request) {
        approvals.push(request)
        let decision: "allow" | "ask" | "deny" | "unavailable"
        if (request.method === "sandbox/network") {
          if (!object(request.input) || request.input.host !== "127.0.0.1") decision = "deny"
          // Only this host-created fixture capability bypasses the workspace
          // ask; it cannot select an arbitrary model host or destination.
          else if (request.input.port === providerPort) decision = "allow"
          else if (request.input.port === originPort) decision = toolApprovalDecision(request, policy, cwd)
          else decision = "deny"
        } else decision = toolApprovalDecision(request, policy, cwd)
        decisions.push({ requestId: request.requestId, decision })
        return decision
      },
      async ask(request, signal) {
        asks.push(request)
        asked.resolve(signal)
        return release.promise
      },
    })
    const runDir = join(dir, "adapters", "runs", runId)
    const home = join(runDir, "native-home")
    const configDir = join(home, ".claude")
    mkdirSync(configDir, { recursive: true })
    // New, synthetic config only; no host account/config is loaded.
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }))
    const adapter = new ClaudeAdapter({
      sandbox: new SandboxRuntime(), stateDir: join(dir, "adapters"), configDir,
      binary: wrapper(dir, runtime.binary, join(runDir, "official-cli.stderr.log")), networkCeiling,
    })
    session = await deadline(adapter.start({
      runId, cwd, prompt: "Perform the single deterministic synthetic tool diagnostic.", model: MODEL,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: synthetic.url, ANTHROPIC_API_KEY: KEY,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
      },
      policy, networkAllow: [...networkCeiling], toolApproval: gate, log: createLogger(),
    }), "official ClaudeAdapter start")
    finished = (async () => { for await (const event of session!.events()) events.push(event) })()
    if (["network-ask-allow", "network-ask-deny", "network-cancel"].includes(scenario)) {
      const signal = await deadline(asked.promise, "actual outer network approval")
      expect(asks).toHaveLength(1)
      expect(asks[0]).toMatchObject({ runId, harness: "claude_code", method: "sandbox/network", input: { host: "127.0.0.1", port: originPort } })
      expect(hits).toEqual([])
      expect(existsSync(marker)).toBe(true)
      if (scenario === "network-cancel") {
        await deadline(session.cancel(), "official Claude session cancellation")
        expect(signal.aborted).toBe(true)
        release.resolve("allow") // The late host answer must not revive traffic.
      } else release.resolve(scenario === "network-ask-allow" ? "allow" : "deny")
    }
    await deadline(finished, "official Claude session completion")
    expect(synthetic.failures).toEqual([])
    expect(synthetic.requests.some((request) => request.route === "/v1/messages")).toBe(true)
    expect(approvals.some((request) => request.method === "sandbox/network" && object(request.input) && request.input.port === providerPort)).toBe(true)
    if (restricted) {
      expect(existsSync(marker)).toBe(false)
      expect(hits).toEqual([])
      expect(asks).toEqual([])
      const output = await deadline(synthetic.toolOutput.promise, "restricted native Bash tool result")
      expect(output.is_error, "forced unavailable Bash must explicitly fail").toBe(true)
      expect(decisions.filter((item) => item.decision === "allow" && approvals.some((request) => request.requestId === item.requestId && request.method === "cli/Bash"))).toEqual([])
    } else {
      // A real callback is required: an SDK-local auto-allow cannot count as
      // evidence that ClaudeAdapter's canUseTool reached the host gate.
      const native = approvals.filter((request) => request.method === (write ? "cli/Write" : "cli/Bash"))
      expect(native, "official native tool must reach actual canUseTool").toHaveLength(1)
      expect(native[0]).toMatchObject({ runId, harness: "claude_code", input: toolInput })
      expect(decisions.find((item) => item.requestId === native[0]?.requestId)?.decision).toBe("allow")
      expect(existsSync(marker)).toBe(true)
      if (scenario === "network-cancel") {
        expect(hits).toEqual([])
        expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "cancelled" })
      } else {
        const output = await deadline(synthetic.toolOutput.promise, "official native tool result in subsequent Messages request")
        if (write) {
          expect(output.is_error).not.toBe(true)
          expect(readFileSync(marker, "utf8")).toBe(CONTENT)
          expect(hits).toEqual([])
        } else {
          const allowed = scenario === "network-allow" || scenario === "network-ask-allow"
          const observed = probeResult(output.content)
          expect(observed, "real Bash result must contain the observed proxy response").toBeDefined()
          if (allowed) expect(observed).toEqual({ status: 200, body: "synthetic-origin-ok" })
          else expect(observed?.status).toBe(403)
          expect(hits).toEqual(allowed ? ["/probe"] : [])
        }
        expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" })
      }
      if (scenario === "network-outside-ceiling") expect(approvals.filter((request) => request.method === "sandbox/network" && object(request.input) && request.input.port === originPort)).toEqual([])
      if (!["network-ask-allow", "network-ask-deny", "network-cancel"].includes(scenario)) expect(asks).toEqual([])
    }
    if (restricted) expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" })
    expect(events.filter((event) => event.type === "exit")).toHaveLength(1)
  } catch (error) {
    failure = String(error)
    throw error
  } finally {
    release.resolve("deny")
    gate?.revoke()
    const cleanup = await Promise.allSettled([
      deadline(session?.detach?.() ?? Promise.resolve(), "diagnostic process teardown"),
      deadline(finished ?? Promise.resolve(), "diagnostic event teardown"),
      synthetic?.close() ?? Promise.resolve(), origin?.close() ?? Promise.resolve(),
    ])
    cleanupErrors.push(...cleanup.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []))
    writeFileSync(join(dir, "evidence.json"), JSON.stringify({
      classification: "official Claude SDK/CLI with synthetic provider; diagnostic, not product provider acceptance",
      runtime, cwd, modelSchemaSelector: MODEL, scenario, policy, networkCeiling, hits, approvals, asks, decisions,
      requests: synthetic?.requests ?? [], providerFailures: synthetic?.failures ?? [], cleanupErrors, failure, events,
    }, null, 2))
  }
  if (cleanupErrors.length) throw new Error(`diagnostic cleanup failed: ${cleanupErrors.join("; ")}`)
}

// Observe actual socket admissions while preserving the broker's real grant,
// pending-review, digest and execution checks. No driver process is started.
class ObservedComputerBroker extends ComputerBroker {
  readonly calls: unknown[] = []
  override request(token: string, value: unknown, signal?: AbortSignal) {
    this.calls.push(structuredClone(value))
    return super.request(token, value, signal)
  }
}

async function computerDiagnostic(runtime: OfficialRuntime) {
  const dir = mkdtempSync(join(tmpdir(), "mikka-official-claude-computer-"))
  const cwd = await makeRepo()
  console.info(`Retained official Claude computer diagnostic: ${dir}; worktree: ${cwd}`)
  const runId = "official-claude-computer-run"
  const policy = runPolicy(undefined)
  policy.networkAllow = []
  policy.permissions.network = "ask"
  policy.permissions.computer_use = "ask"
  const approvals: ToolApprovalRequest[] = []
  const asks: ToolApprovalRequest[] = []
  const decisions: { requestId: string; decision: string }[] = []
  const events: AgentEvent[] = []
  const executions: unknown[] = []
  const reviews: ReturnType<ComputerBroker["list"]> = []
  const cleanupErrors: string[] = []
  let live = true
  const broker = new ObservedComputerBroker({
    transport: "tcp", socketPath: join(dir, "unused-broker-path"),
    driver: { installed: true, path: "/synthetic/no-computer-driver", version: "synthetic", fingerprint: "c".repeat(64) },
    permitted: id => live && id === runId,
    async execute(_driver, call, _display, id, context) {
      context.assertLive()
      expect(id).toBe(runId)
      expect(call).toEqual({ name: "get_desktop_state", arguments: {} })
      executions.push(structuredClone(call))
      return { content: [{ type: "text", text: COMPUTER_RESULT }] }
    },
  })
  let synthetic: Awaited<ReturnType<typeof provider>> | undefined
  let gate: ToolApprovalGate | undefined
  let session: AgentSession | undefined
  let finished: Promise<void> | undefined
  let networkCeiling: readonly string[] = []
  let failure: string | undefined
  try {
    await broker.listen()
    const grant = broker.spec(runId, policy.permissions.computer_use)
    if (!grant) throw new Error("synthetic ask broker grant unavailable")
    const brokerDomain = new URL(grant.socketPath).host
    const brokerPort = Number(new URL(grant.socketPath).port)
    synthetic = await provider(COMPUTER_TOOL, {}, false)
    const providerPort = synthetic.port
    networkCeiling = Object.freeze([`127.0.0.1:${providerPort}`, brokerDomain])
    gate = new ToolApprovalGate(runId, {
      isLive: id => live && id === runId,
      permission(request) {
        approvals.push(request)
        // The provider's exact loopback port is the only fixture-specific
        // exception. Broker transport must use the adapter's trusted endpoint
        // capability, so an accidental second network approval fails closed.
        const decision = request.method === "sandbox/network"
          ? object(request.input) && request.input.host === "127.0.0.1" && request.input.port === providerPort ? "allow" : "deny"
          : toolApprovalDecision(request, policy, cwd)
        decisions.push({ requestId: request.requestId, decision })
        return decision
      },
      async ask(request) { asks.push(request); return "deny" as const },
    })
    const runDir = join(dir, "adapters", "runs", runId)
    const home = join(runDir, "native-home")
    const configDir = join(home, ".claude")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }))
    const adapter = new ClaudeAdapter({
      sandbox: new SandboxRuntime(), stateDir: join(dir, "adapters"), configDir,
      binary: wrapper(dir, runtime.binary, join(runDir, "official-cli.stderr.log")), networkCeiling,
      computerMcp: {
        command: process.execPath,
        args: [realpathSync(join(import.meta.dirname, "../src/computer/proxy.mjs")), grant.socketPath, grant.token],
        env: {},
      },
    })
    session = await deadline(adapter.start({
      runId, cwd, policy, toolApproval: gate, networkAllow: [...networkCeiling],
      prompt: "Perform the single deterministic synthetic computer tool diagnostic.", model: MODEL,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: synthetic.url, ANTHROPIC_API_KEY: KEY,
        // Advertise the fixed MCP schema directly to the canned provider.
        ENABLE_TOOL_SEARCH: "false",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
      },
      log: createLogger(),
    }), "official Claude computer session start")
    finished = (async () => { for await (const event of session!.events()) events.push(event) })()
    const pending = await deadline(waitFor(() => broker.list()[0], 30_000), "actual broker ask from official CLI MCP proxy")
    expect(broker.calls).toEqual([{ name: "get_desktop_state", arguments: {} }])
    expect(broker.list()).toHaveLength(1)
    expect(pending).toMatchObject({ runId, call: { name: "get_desktop_state", arguments: {} } })
    expect(executions).toEqual([])
    expect(asks).toEqual([])
    reviews.push(structuredClone(pending))
    // Only this in-process trusted reviewer decides the broker's action ask.
    // The CLI transport permit is never used as an action approval.
    await deadline(broker.decide(pending.id, pending.digest, true), "synthetic broker review")
    await deadline(finished, "official CLI computer session completion")
    const output = await deadline(synthetic.toolOutput.promise, "real MCP result in subsequent Messages request")
    expect(output.is_error).not.toBe(true)
    expect(JSON.stringify(output.content)).toContain(COMPUTER_RESULT)
    expect(synthetic.failures).toEqual([])
    expect(broker.calls).toEqual([{ name: "get_desktop_state", arguments: {} }])
    expect(executions).toEqual([{ name: "get_desktop_state", arguments: {} }])
    expect(broker.list()).toEqual([])
    const native = approvals.filter(request => request.method.startsWith("cli/"))
    expect(native).toHaveLength(1)
    expect(native[0]).toMatchObject({ runId, harness: "claude_code", method: `cli/${COMPUTER_TOOL}`, input: {} })
    expect(decisions.find(decision => decision.requestId === native[0]?.requestId)?.decision).toBe("allow")
    expect(approvals.some(request => request.method === "sandbox/network" && object(request.input) && request.input.port === providerPort)).toBe(true)
    expect(approvals.filter(request => request.method === "sandbox/network" && object(request.input) && request.input.port === brokerPort)).toEqual([])
    expect(asks).toEqual([])
    expect(events.filter(event => event.type === "exit")).toEqual([expect.objectContaining({ type: "exit", outcome: "succeeded" })])
  } catch (error) {
    failure = String(error)
    throw error
  } finally {
    live = false
    gate?.revoke()
    const cleanup = await Promise.allSettled([
      deadline(session?.detach?.() ?? Promise.resolve(), "computer diagnostic process teardown"),
      deadline(finished ?? Promise.resolve(), "computer diagnostic event teardown"),
      synthetic?.close() ?? Promise.resolve(), broker.close(),
    ])
    cleanupErrors.push(...cleanup.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []))
    writeFileSync(join(dir, "evidence.json"), JSON.stringify({
      classification: "official Claude SDK/CLI and real MCP proxy/SRT with synthetic Messages/broker execution; diagnostic only",
      runtime, cwd, modelSchemaSelector: MODEL, scenario: "computer-proxy-ask", policy, networkCeiling,
      approvals, asks, decisions, brokerCalls: broker.calls, brokerReviews: reviews, executions,
      requests: synthetic?.requests ?? [], providerFailures: synthetic?.failures ?? [], cleanupErrors, failure, events,
    }, null, 2))
  }
  if (cleanupErrors.length) throw new Error(`computer diagnostic cleanup failed: ${cleanupErrors.join("; ")}`)
}

describe.skipIf(!enabled)("official Claude SDK / synthetic Messages / real outer sandbox diagnostic", () => {
  let runtime: OfficialRuntime
  beforeAll(() => {
    // Neither opt-in nor unavailable dependencies can silently turn a requested
    // acceptance run into success. No fake query/CLI/launcher fallback exists.
    runtime = officialRuntime()
    expect(existsSync(runtime.binary)).toBe(true)
    expect(SandboxRuntime.supported(), "real SRT dependencies must be installed; no unsandboxed fallback").toBe(true)
  })

  it.each([
    "write-allow", "network-allow", "network-ask-allow", "network-ask-deny",
    "network-cancel", "network-outside-ceiling", "bash-restricted",
  ] as const)("observes actual native tool and host gate: %s", async (scenario) => {
    await diagnostic(runtime, scenario)
  }, 90_000)

  it("propagates the actual CLI MCP proxy environment to the broker under computer ask policy", async () => {
    await computerDiagnostic(runtime)
  }, 90_000)
})
