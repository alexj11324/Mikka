// Diagnostic integration: official Codex 0.163.0, real adapter/gate/outer sandbox,
// synthetic loopback Responses SSE only. No account, real provider or inference.
// Native exec is deliberately enabled for the network transport diagnostic.
// This does not establish product provider or full semantic policy acceptance.
// The test owns its servers/processes; directories and logs remain as evidence.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { gunzipSync } from "node:zlib"

import { beforeAll, describe, expect, it } from "vitest"

import { CodexAdapter } from "../src/adapters/codex"
import type { AgentEvent, AgentSession } from "../src/adapters/types"
import { SandboxRuntime, shellJoin, shellQuote } from "../src/agents/sandbox"
import { ToolApprovalGate, type ToolApprovalRequest } from "../src/agents/tool-approval"
import { createLogger } from "../src/log"
import { makeRepo } from "./helpers"

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

async function provider(command: string, native: "enabled" | "disabled") {
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
      const output = Array.isArray(input.input) ? input.input.find((item) => object(item) && item.type === "function_call_output" && item.call_id === CALL_ID) : undefined
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
      if (native === "disabled" && raw.length) throw new Error(`native shell still advertised: ${raw.map((tool) => tool.name).join(",")}`)
      const exec = tools.find((tool) => tool.name === "exec_command")
      if (native === "enabled" && !exec) throw new Error("official CLI did not advertise exec_command")
      // In disabled mode deliberately send an unavailable native call as a
      // negative control; it must return an error without running the command.
      sse(response, "synthetic_response_tool", {
        id: "synthetic_function", type: "function_call", status: "completed", call_id: CALL_ID,
        name: "exec_command", ...(exec?.namespace ? { namespace: exec.namespace } : {}),
        arguments: JSON.stringify({ cmd: command, yield_time_ms: 10000, max_output_tokens: 1000 }),
      })
    })().catch((error: unknown) => {
      failures.push(String(error))
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: String(error), type: "fixture_error" } }))
    })
  })
  return { ...listening, requests, failures, toolOutput }
}

function wrapper(dir: string, binary: string, baseUrl: string, native: "enabled" | "disabled") {
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
    `features.shell_tool=${native === "enabled"}`,
    `features.unified_exec=${native === "enabled"}`,
    "analytics.enabled=false",
  ].flatMap((value) => ["-c", value])
  // sandbox-runtime inserts loopback NO_PROXY entries. Clear these inside
  // its boundary so the real CLI's local provider request uses the real proxy.
  // This script only execs the pinned binary; it never implements CLI/RPC/tools.
  writeFileSync(file, `#!/bin/sh\nexport NO_PROXY='' no_proxy=''\nexec ${shellQuote(binary)} "$@" ${shellJoin(config)} 2>>${shellQuote(join(dir, "official-cli.stderr.log"))}\n`, { mode: 0o700 })
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
async function diagnostic(binary: string, decision: Decision, native: "enabled" | "disabled" = "enabled") {
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
      binary: wrapper(dir, binary, synthetic.url, native),
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
    if (native === "disabled") {
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
})
