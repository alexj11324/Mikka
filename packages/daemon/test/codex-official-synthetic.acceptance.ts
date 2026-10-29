// Diagnostic integration: official Codex 0.163.0, real adapter/gate/outer sandbox,
// synthetic loopback Responses SSE only. No account, real provider or inference.
// Native exec is deliberately enabled for the network transport diagnostic.
// This does not establish product provider or full semantic policy acceptance.
// The test owns its servers/processes; directories and logs remain as evidence.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { gunzipSync } from "node:zlib"
import { fileURLToPath } from "node:url"
import { defaultRunPolicy } from "@mikka/protocol/agent-policy"

import { beforeAll, describe, expect, it } from "vitest"

import { CodexAdapter } from "../src/adapters/codex"
import type { AgentEvent, AgentSession } from "../src/adapters/types"
import { SandboxRuntime, shellJoin, shellQuote } from "../src/agents/sandbox"
import { ToolApprovalGate, type ToolApprovalRequest } from "../src/agents/tool-approval"
import { toolApprovalDecision } from "../src/agents/tool-approval-policy"
import { ComputerBroker } from "../src/computer/broker.mjs"
import { createLogger } from "../src/log"
import { makeRepo, waitFor } from "./helpers"

const enabled = process.env.MIKKA_SANDBOX_ACCEPTANCE === "1"
const MODEL = "gpt-5.1-codex" // A tool-schema selector, never a real model call.
const CALL_ID = "synthetic_native_exec_call"
const SYNTHETIC_KEY = "synthetic-local-fixture-no-provider-credential"

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
  if (!address || typeof address === "string") throw new Error("missing fixture server address")
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

type JsonObject = Record<string, unknown>
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function clippedContext(value: unknown, secrets: readonly string[]) {
  return JSON.stringify(value, (key, item: unknown) => {
    if (/token|authorization|cookie|password|secret|api.?key/i.test(key)) return '[redacted]'
    return typeof item === 'string' ? secrets.reduce((text, secret) => secret ? text.replaceAll(secret, '[redacted]') : text, item) : item
  }).slice(0, 6500)
}

function declaredTools(tools: unknown, namespace?: string): { name: string; namespace?: string }[] {
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool) => {
    if (!object(tool)) return []
    if (tool.type === "namespace" && typeof tool.name === "string") return declaredTools(tool.tools, tool.name)
    return typeof tool.name === "string" ? [{ name: tool.name, ...(namespace ? { namespace } : {}) }] : []
  })
}

// The official Responses parser consumes actual SSE events, not app-server RPC
// synthesized by this fixture. Capture its next request to prove tool execution.
function sse(response: ServerResponse, id: string, item: JsonObject) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const emit = (type: string, payload: JsonObject) => response.write(
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
  )
  emit("response.created", { response: { id, object: "response", status: "in_progress", output: [] } })
  emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } })
  emit("response.output_item.done", { output_index: 0, item })
  emit("response.completed", {
    response: {
      id, object: "response", status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  })
  response.end()
}

async function provider(command: string, native: "enabled" | "disabled" | "restricted", target?: { name: string; namespace: string; arguments: JsonObject; callId: string }) {
  const requests: JsonObject[] = []
  const failures: string[] = []
  const toolOutput = deferred<JsonObject>()
  const listening = await server((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") throw new Error(`unexpected provider route: ${request.method} ${request.url}`)
      if (request.headers.authorization !== `Bearer ${SYNTHETIC_KEY}`) throw new Error("synthetic provider auth mismatch")
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 2_000_000) throw new Error("fixture request too large")
        chunks.push(Buffer.from(chunk))
      }
      let body = Buffer.concat(chunks)
      if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body)
      else if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw new Error("unsupported fixture request encoding")
      const input: unknown = JSON.parse(body.toString())
      if (!object(input)) throw new Error("invalid Responses request")
      requests.push(input)
      if (requests.length > 3) throw new Error("unexpected extra Responses request")
      const output = Array.isArray(input.input) ? input.input.find((item) => object(item) && item.type === "function_call_output" && item.call_id === (target?.callId ?? CALL_ID)) : undefined
      if (object(output)) {
        toolOutput.resolve(output)
        sse(response, "synthetic_response_final", {
          id: "synthetic_message", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "Synthetic CLI diagnostic complete.", annotations: [] }],
        })
        return
      }
      const tools = declaredTools(input.tools)
      const raw = tools.filter((tool) => ["exec_command", "shell", "shell_command", "write_stdin"].includes(tool.name))
      if (native !== "enabled" && raw.length) throw new Error(`native shell still advertised: ${raw.map((tool) => tool.name).join(",")}`)
      const exec = tools.find((tool) => tool.name === "exec_command")
      if (native === "enabled" && !exec) throw new Error("official CLI did not advertise exec_command")
      const selected = target ? tools.find(tool => tool.name === target.name && tool.namespace === target.namespace) : exec
      if (target && !selected) throw new Error(`official CLI did not advertise registered ${target.namespace}.${target.name}; tools=${JSON.stringify(tools)}`)
      // In disabled mode deliberately send an unavailable native call as a
      // negative control; it must return an error without running the command.
      sse(response, "synthetic_response_tool", {
        id: "synthetic_function", type: "function_call", status: "completed", call_id: target?.callId ?? CALL_ID,
        name: target?.name ?? "exec_command", ...(selected?.namespace ? { namespace: selected.namespace } : {}),
        arguments: JSON.stringify(target?.arguments ?? { cmd: command, yield_time_ms: 10000, max_output_tokens: 1000 }),
      })
    })().catch((error: unknown) => {
      failures.push(String(error))
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: String(error), type: "fixture_error" } }))
    })
  })
  return { ...listening, requests, failures, toolOutput }
}

function wrapper(dir: string, binary: string, baseUrl: string, native: "enabled" | "disabled" | "restricted", stderrPath: string) {
  const file = join(dir, "official-codex-wrapper.sh")
  const config = [
    'model_provider="synthetic_acceptance"',
    'model_providers.synthetic_acceptance.name="Synthetic loopback fixture"',
    `model_providers.synthetic_acceptance.base_url=${JSON.stringify(`${baseUrl}/v1`)}`,
    'model_providers.synthetic_acceptance.env_key="MIKKA_SYNTHETIC_PROVIDER_KEY"',
    'model_providers.synthetic_acceptance.wire_api="responses"',
    "model_providers.synthetic_acceptance.requires_openai_auth=false",
    "model_providers.synthetic_acceptance.supports_websockets=false",
    "features.responses_websockets=false",
    "features.responses_websockets_v2=false",
    ...(native === 'restricted' ? [] : [`features.shell_tool=${native === "enabled"}`]),
    `features.unified_exec=${native !== "disabled"}`,
    "analytics.enabled=false",
  ].flatMap((value) => ["-c", value])
  // sandbox-runtime inserts loopback NO_PROXY entries. Clear these inside
  // its boundary so the real CLI's local provider request uses the real proxy.
  // This script only execs the pinned binary; it never implements CLI/RPC/tools.
  writeFileSync(file, `#!/bin/sh\nexport NO_PROXY='' no_proxy=''\nexec ${shellQuote(binary)} "$@" ${shellJoin(config)} 2>>${shellQuote(stderrPath)}\n`, { mode: 0o700 })
  return file
}

const PROBE = String.raw`
const http = require('node:http');
const fs = require('node:fs');
const proxy = new URL(process.env.HTTP_PROXY);
fs.writeFileSync(process.argv[3], 'official-native-exec-ran');
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
request.on('error', error => { console.log(JSON.stringify({error:error.code})); process.exitCode=8; });
request.setTimeout(20000, () => request.destroy(new Error('fixture deadline')));
request.end();
`

type Decision = "allow" | "ask-allow" | "ask-deny" | "deny" | "abort" | "outside-ceiling"

function probeResult(value: unknown, depth = 0): {status:number;body:string} | undefined {
  if (depth > 8) return
  if (object(value)) {
    if (Number.isInteger(value.status) && typeof value.body === 'string') return value as {status:number;body:string}
    for (const item of Object.values(value)) { const found=probeResult(item,depth+1); if (found) return found }
  } else if (Array.isArray(value)) {
    for (const item of value) { const found=probeResult(item,depth+1); if (found) return found }
  } else if (typeof value === 'string') {
    for (const line of [value,...value.split(/\r?\n/)]) {
      try { const parsed:unknown=JSON.parse(line); if (typeof parsed !== 'string') { const found=probeResult(parsed,depth+1); if (found) return found } } catch {}
    }
  }
}
async function diagnostic(binary: string, decision: Decision, native: "enabled" | "disabled" | "restricted" = "enabled") {
  const dir = mkdtempSync(join(tmpdir(), "mikka-official-codex-synthetic-"))
  const cwd = await makeRepo()
  console.info(`Retained official CLI synthetic diagnostic: ${dir}; worktree: ${cwd}`)
  const hits: string[] = []
  const origin = await server((request, response) => {
    hits.push(request.url ?? "")
    response.end("synthetic-origin-ok")
  })
  const marker = join(cwd, "native-exec-marker")
  const probe = join(cwd, "synthetic-proxy-probe.cjs")
  let synthetic: Awaited<ReturnType<typeof provider>>
  try {
    writeFileSync(probe, PROBE)
    synthetic = await provider(shellJoin([process.execPath, probe, `${origin.url}/probe`, marker]), native)
  } catch (error) {
    await origin.close()
    throw error
  }
  const asked = deferred<AbortSignal>()
  const permissionSeen = deferred<void>()
  const release = deferred<"allow" | "deny">()
  const approvals: ToolApprovalRequest[] = []
  const asks: ToolApprovalRequest[] = []
  const runId = "official-synthetic-run"
  const gate = new ToolApprovalGate(runId, {
    isLive: () => true,
    permission(request) {
      approvals.push(request)
      if (request.method !== "sandbox/network" || !object(request.input)) return "deny"
      if (request.input.host !== "127.0.0.1") return "deny"
      if (request.input.port === synthetic.port) return "allow"
      if (request.input.port !== origin.port) return "deny"
      permissionSeen.resolve()
      return decision === "allow" ? "allow" : decision === "deny" ? "deny" : "ask"
    },
    async ask(request, signal) {
      asks.push(request)
      asked.resolve(signal)
      return release.promise
    },
  })
  const events: AgentEvent[] = []
  let session: AgentSession | undefined
  let finished: Promise<void> | undefined
  const cleanupErrors: string[] = []
  try {
    const adapter = new CodexAdapter({
      sandbox: new SandboxRuntime(), stateDir: dir, userHome: dir,
      binary: wrapper(dir, binary, synthetic.url, native, join(dir,'runs',runId,'official-cli.stderr.log')),
      networkCeiling: [`127.0.0.1:${synthetic.port}`, ...(decision === 'outside-ceiling' ? [] : [`127.0.0.1:${origin.port}`])],
    })
    session = await deadline(adapter.start({
      runId, cwd, prompt: "Execute only the supplied deterministic synthetic diagnostic.", model: MODEL,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, MIKKA_SYNTHETIC_PROVIDER_KEY: SYNTHETIC_KEY },
      networkAllow: [`127.0.0.1:${synthetic.port}`, ...(decision === "outside-ceiling" ? [] : [`127.0.0.1:${origin.port}`])],
      toolApproval: gate, log: createLogger(),
    }), "official adapter start")
    finished = (async () => { for await (const event of session!.events()) events.push(event) })()
    if (native === "enabled" && (decision === "ask-allow" || decision === "ask-deny" || decision === "abort")) {
      const signal = await deadline(asked.promise, "actual outer network approval")
      expect(hits).toEqual([])
      expect(asks).toHaveLength(1)
      expect(asks[0]?.input).toEqual({ host: "127.0.0.1", port: origin.port })
      if (decision === "abort") {
        await deadline(session.cancel(), "official session cancellation")
        expect(signal.aborted).toBe(true)
        release.resolve("allow") // A late host answer cannot revive the run.
      } else release.resolve(decision === "ask-deny" ? "deny" : "allow")
    }
    await deadline(finished, "official session completion")
    expect(synthetic.failures).toEqual([])
    expect(synthetic.requests.length).toBeGreaterThan(0)
    expect(approvals.some((request) => object(request.input) && request.input.port === synthetic.port)).toBe(true)
    if (native !== "enabled") {
      expect(existsSync(marker)).toBe(false)
      expect(asks).toEqual([])
      expect(hits).toEqual([])
      const rejected = await deadline(synthetic.toolOutput.promise, "unavailable native tool output")
      expect(JSON.stringify(rejected.output)).toMatch(/unsupported|unknown|unrecognized|not found|not available/i)
    } else {
      expect(existsSync(marker)).toBe(true)
      if (decision === "abort") {
        expect(hits).toEqual([])
        expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "cancelled" })
      } else {
        const result = await deadline(synthetic.toolOutput.promise, "official native tool result")
        const observed = probeResult(result.output)
        expect(observed).toBeDefined()
        if (decision === 'allow' || decision === 'ask-allow') expect(observed).toEqual({status:200,body:'synthetic-origin-ok'})
        else expect(observed?.status).toBe(403)
        expect(hits).toEqual(decision === "allow" || decision === "ask-allow" ? ["/probe"] : [])
        expect(events.some((event) => event.type === "chunk" && event.chunk.type === "tool-input-available" && event.chunk.toolName === "bash")).toBe(true)
        expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" })
      }
      if (decision === "allow" || decision === "deny") await deadline(permissionSeen.promise, "real network gate policy")
      if (decision === "outside-ceiling") expect(approvals.filter((request) => object(request.input) && request.input.port === origin.port)).toEqual([])
      if (decision !== "ask-allow" && decision !== "ask-deny" && decision !== "abort") expect(asks).toEqual([])
    }
  } finally {
    release.resolve("deny")
    gate.revoke()
    const cleanup = await Promise.allSettled([
      deadline(session?.detach?.() ?? Promise.resolve(), "diagnostic teardown"),
      deadline(finished ?? Promise.resolve(), "diagnostic event teardown"),
      synthetic.close(), origin.close(),
    ])
    cleanupErrors.push(...cleanup.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []))
    writeFileSync(join(dir, "evidence.json"), JSON.stringify({
      classification: "official CLI with synthetic provider; diagnostic, not product provider acceptance",
      cwd, binary, modelSchemaSelector: MODEL, native, decision, hits, approvals, asks,
      requests: synthetic.requests, providerFailures: synthetic.failures, cleanupErrors, events,
    }, null, 2))
  }
  if (cleanupErrors.length) throw new Error(`diagnostic cleanup failed: ${cleanupErrors.join("; ")}`)
}

async function computerDiagnostic(binary: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mikka-official-codex-computer-'))
  const cwd = join(dir, 'repo'), userHome = join(dir, 'empty-user-home')
  mkdirSync(cwd); mkdirSync(userHome)
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', cwd], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
  console.info(`Retained official Codex computer MCP diagnostic: ${dir}`)
  const runId = 'official-computer-synthetic-run'
  const toolName = 'mcp__mikka_computer__get_desktop_state'
  const marker = 'synthetic-desktop-result-no-real-device'
  const policy = defaultRunPolicy()
  policy.permissions.computer_use = 'ask'
  policy.permissions.network = 'ask'
  policy.networkAllow = []
  let live = true
  const executed: { runId: string; call: unknown; display: unknown }[] = []
  // Real request-token/decision machinery, synthetic driver output only. Its
  // TCP socket is the same production protocol used by localComputerMcp.
  const broker = new ComputerBroker({
    transport: 'tcp', socketPath: '',
    driver: { installed: true, version: 'synthetic', path: '/synthetic-no-driver', fingerprint: 'f'.repeat(64) },
    permitted: candidate => live && candidate === runId,
    execute: async (_driver, call, display, candidate) => {
      executed.push({ runId: candidate, call, display })
      return { content: [{ type: 'text', text: marker }] }
    },
  })
  const approvals: ToolApprovalRequest[] = [], asks: ToolApprovalRequest[] = []
  const decisions: { method: string; input: unknown; policy: string; effective: string }[] = []
  const events: AgentEvent[] = [], cleanupErrors: string[] = []
  const redactions = [SYNTHETIC_KEY]
  let synthetic: Awaited<ReturnType<typeof provider>> | undefined
  let session: AgentSession | undefined, finished: Promise<void> | undefined
  let review: unknown, result: unknown, brokerEndpoint: string | undefined
  const context = () => clippedContext({ toolResult: result, brokerCalls: executed, pending: broker.list(), approvals, asks, events: events.slice(-12), providerFailures: synthetic?.failures, providerCalls: synthetic?.requests.map((request, index) => ({ index, toolOutputs: Array.isArray(request.input) ? request.input.filter(item => object(item) && item.type === 'function_call_output') : [] })) }, redactions)
  const gate = new ToolApprovalGate(runId, {
    isLive: () => live,
    permission(request) {
      approvals.push(request)
      const decision = toolApprovalDecision(request, policy, cwd)
      // Only the deterministic Responses fixture gets this test capability.
      // Production policy and the broker exemption govern every other call.
      const fixture = request.method === 'sandbox/network' && object(request.input) && request.input.host === '127.0.0.1' && request.input.port === synthetic?.port
      const effective = fixture ? 'allow' : decision
      decisions.push({ method: request.method, input: request.input, policy: decision, effective })
      return effective
    },
    async ask(request) { asks.push(request); return 'deny' },
  })
  try {
    await broker.listen()
    const grant = broker.spec(runId, policy.permissions.computer_use)
    if (!grant) throw new Error('synthetic computer ask grant unavailable')
    redactions.push(grant.token)
    brokerEndpoint = grant.socketPath
    const port = Number(new URL(brokerEndpoint).port)
    synthetic = await provider('', 'disabled', { name: 'get_desktop_state', namespace: 'mcp__mikka_computer', arguments: {}, callId: 'synthetic_computer_mcp_call' })
    void synthetic.toolOutput.promise.then(output => { result = output })
    const adapter = new CodexAdapter({
      sandbox: new SandboxRuntime(), stateDir: dir, userHome,
      binary: wrapper(dir, binary, synthetic.url, 'disabled', join(dir, 'runs', runId, 'official-cli.stderr.log')),
      computerMcp: {
        command: process.execPath,
        args: [fileURLToPath(new URL('../src/computer/proxy.mjs', import.meta.url)), grant.socketPath, grant.token],
        env: {},
      },
      // The adapter must add only its trusted broker endpoint to the run's
      // policy, then intersect this immutable maximum. No real API is in cap.
      networkCeiling: [`127.0.0.1:${synthetic.port}`, `127.0.0.1:${port}`],
    })
    session = await deadline(adapter.start({
      runId, cwd, model: MODEL, prompt: 'Use only the registered computer get_desktop_state tool once.', policy,
      networkAllow: [`127.0.0.1:${synthetic.port}`],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: userHome, MIKKA_SYNTHETIC_PROVIDER_KEY: SYNTHETIC_KEY },
      toolApproval: gate, log: createLogger(),
    }), 'official Codex computer adapter start')
    finished = (async () => { for await (const event of session!.events()) events.push(event) })()
    void finished.catch(() => undefined)
    const pending = await deadline(waitFor(() => {
      if (synthetic!.failures.length) throw new Error(`official computer tool fixture failed: ${context()}`)
      const terminal = events.at(-1)
      if (terminal?.type === 'exit') throw new Error(`official Codex ended before the registered computer request: ${context()}`)
      return broker.list()[0]
    }), 'official CLI registered computer MCP request')
    review = pending
    expect(pending).toMatchObject({ runId, call: { name: 'get_desktop_state', arguments: {} } })
    expect(broker.list()).toHaveLength(1)
    expect(executed).toEqual([])
    expect(asks, 'computer transport must not request a second tool/network approval').toEqual([])
    await broker.decide(pending.id, pending.digest, true)
    result = await deadline(synthetic.toolOutput.promise, 'official CLI computer MCP output returned to Responses')
    await deadline(finished, 'official Codex computer diagnostic completion')
    expect(synthetic.failures).toEqual([])
    expect(synthetic.requests).toHaveLength(2)
    expect(JSON.stringify(result)).toContain(marker)
    expect(executed).toEqual([{ runId, call: { name: 'get_desktop_state', arguments: {} }, display: undefined }])
    expect(broker.list()).toEqual([])
    expect(asks).toEqual([])
    expect(approvals.length).toBeGreaterThan(0)
    expect(approvals.filter(request => request.method === 'sandbox/network').every(request => object(request.input) && request.input.host === '127.0.0.1' && request.input.port === synthetic!.port), 'only the synthetic provider should enter the ordinary network gate').toBe(true)
    expect(approvals.filter(request => request.method !== 'sandbox/network').map(request => request.method)).toEqual([`cli/${toolName}`])
    expect(events.some(event => event.type === 'chunk' && event.chunk.type === 'tool-input-available' && event.chunk.toolName === toolName)).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
  } finally {
    live = false
    gate.revoke()
    const cleanup = await Promise.allSettled([
      deadline(session?.cancel() ?? Promise.resolve(), 'computer diagnostic child teardown'),
      deadline(finished ?? Promise.resolve(), 'computer diagnostic event teardown'),
      synthetic?.close() ?? Promise.resolve(), broker.close(),
    ])
    cleanupErrors.push(...cleanup.flatMap(item => item.status === 'rejected' ? [String(item.reason)] : []))
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify({
      classification: 'official Codex0.163 CLI and production computer proxy/broker inside real SRT; synthetic Responses and desktop output; no real account/provider/driver',
      cwd, binary, policy, brokerEndpoint, review, result, executed, approvals, decisions, asks,
      requests: synthetic?.requests, providerFailures: synthetic?.failures, cleanupErrors, events,
    }, null, 2))
  }
  if (cleanupErrors.length) throw new Error(`computer diagnostic cleanup failed: ${cleanupErrors.join('; ')}`)
}

describe.skipIf(!enabled)("official Codex / synthetic provider / real outer sandbox diagnostic", () => {
  let binary: string
  beforeAll(() => {
    binary = process.env.CODEX_CONTRACT_BIN ?? ""
    // A requested acceptance run must fail if the real pinned dependency is
    // missing; it must never silently skip or substitute the fake CLI.
    expect(isAbsolute(binary), "CODEX_CONTRACT_BIN must name the absolute official Codex 0.163.0 binary").toBe(true)
    expect(existsSync(binary), "official Codex contract binary missing").toBe(true)
    const version = execFileSync(binary, ["--version"], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    }).trim()
    expect(version).toMatch(/^codex-cli 0\.163\.0$/)
    expect(process.platform).toBe("linux")
  })

  it.each(["allow", "ask-allow", "ask-deny", "deny", "abort", "outside-ceiling"] as const)(
    "diagnoses actual native exec and outer-network %s with no real provider", async (decision) => {
      await diagnostic(binary, decision)
    }, 90_000,
  )

  it("omits disabled native shell tools and rejects a forced exec call without executing it", async () => {
    await diagnostic(binary, "allow", "disabled")
  }, 90_000)
  it('uses the production restricted-policy shell boundary even with unified_exec enabled', async () => {
    await diagnostic(binary,'allow','restricted')
  },90_000)
  it('invokes registered computer MCP through the official CLI and real sandbox proxy with one broker approval', async () => {
    await computerDiagnostic(binary)
  }, 90_000)
})
