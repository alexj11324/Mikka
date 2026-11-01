// A run's own API key (`modelCredential`): it reaches the run's Agent in
// memory only, is never written to the journal, a restarted daemon does not
// run on without it, and a cloud worker's broker adds it on the host side.
import { readFileSync } from "node:fs"
import { request } from "node:http"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { RunAssignment } from "@mikka/protocol"
import { createApiKeyBroker } from "../src/api-key-broker"
import { MockAdapter } from "../src/adapters/mock"
import type { StartOptions } from "../src/adapters/types"
import { Daemon } from "../src/main"
import { RunJournal } from "../src/runs/journal"
import { MemoryServer } from "../src/server-link"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"

const DEVICE = "device-1"
const KEY = "fixture-model-key-0123456789abcdef"
const credential = { kind: "provider" as const, protocol: "anthropic" as const, baseUrl: "https://llm.example.com/anthropic", key: KEY }
const daemons: Daemon[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const daemon of daemons.splice(0)) await daemon.stop()
  cleanupTempDirs()
})

async function boot(server: MemoryServer, dataDir: string) {
  const daemon = await new Daemon({
    dataDir, flavor: "dev", agentSandbox: null, link: server.link(), credential: "cred-1",
    harnesses: [{ harness: "mock", installed: true, version: "test" }], mockSpeed: Number.POSITIVE_INFINITY,
    heartbeatMs: 50, quotaSource: null,
  }).start()
  daemons.push(daemon)
  await daemon.syncWithServer()
  return daemon
}

async function setup() {
  const repo = await makeRepo()
  const server = new MemoryServer(DEVICE)
  server.addRepo(DEVICE, { repoId: "repo-1", name: "sandbox", path: repo })
  return { server, dataDir: tempDir() }
}

it("hands the key to the run's Agent in memory and never writes it to the journal", async () => {
  const { server, dataDir } = await setup()
  const started: StartOptions[] = []
  const start = MockAdapter.prototype.start
  vi.spyOn(MockAdapter.prototype, "start").mockImplementation(function (this: MockAdapter, options: StartOptions) {
    started.push(options)
    return start.call(this, options)
  })
  const daemon = await boot(server, dataDir)
  const runId = server.queueRun(DEVICE, {
    issueId: "issue-api-key", repoId: "repo-1", baseBranch: "main", harness: "mock", prompt: "do it",
    fixture: "success-edit", modelCredential: credential,
  })
  await daemon.syncWithServer()
  await waitFor(() => daemon.supervisor.list().find(run => run.runId === runId))
  await daemon.supervisor.idle()
  await waitFor(() => server.runs.get(runId)?.completion)
  expect(started.map(options => options.credential)).toEqual([credential])
  const journal = readFileSync(join(dataDir, "runs.json"), "utf8")
  expect(journal).not.toContain(KEY)
  expect(JSON.parse(journal).runs[runId].credentialWithheld).toBe(true)
})

it("a restarted daemon stops a run whose key it no longer has instead of running it without one", async () => {
  const dir = tempDir()
  const file = join(dir, "runs.json")
  const assignment = { runId: "run-key", issueId: "i", deviceId: DEVICE, repoId: "repo-1", harness: "mock", prompt: "p", modelCredential: credential } as RunAssignment
  new RunJournal(file).put({ assignment, state: "running", sessionId: null, worktree: null, lastSeq: 0, error: null, updatedAt: new Date().toISOString() })
  const restored = new RunJournal(file).get("run-key")!
  expect(restored.assignment.modelCredential).toBeUndefined()
  expect(restored.credentialWithheld).toBe(true)

  const { server, dataDir } = await setup()
  const runId = server.queueRun(DEVICE, { issueId: "issue-restart", repoId: "repo-1", baseBranch: "main", harness: "mock", prompt: "do it", fixture: "success-edit", modelCredential: credential })
  const queued = server.runs.get(runId)!.assignment
  new RunJournal(join(dataDir, "runs.json")).put({ assignment: { ...queued, deviceId: DEVICE }, state: "running", sessionId: "s", worktree: null, lastSeq: 0, error: null, updatedAt: new Date().toISOString() })
  const started = vi.spyOn(MockAdapter.prototype, "resume")
  await boot(server, dataDir)
  await waitFor(() => server.runs.get(runId)?.completion)
  expect(server.runs.get(runId)?.completion?.stopReason).toBe("error")
  expect(JSON.stringify(server.runs.get(runId)?.completion)).toContain("API key is not kept")
  expect(started).not.toHaveBeenCalled()
})

const post = (socket: string, path: string, headers: Record<string, string>, body = "{}") =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const call = request({ socketPath: socket, path, method: "POST", headers }, response => {
      let text = ""
      response.on("data", part => { text += part })
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }))
    })
    call.on("error", reject)
    call.end(body)
  })

it("the cloud broker adds the key on the host, only toward the run's provider and model paths", async () => {
  let live = true
  const upstream = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json", "set-cookie": "x=1" } }))
  const broker = await createApiKeyBroker({ root: tempDir(), protocol: "anthropic", credential, check: async () => { if (!live) throw new Error("stopped") }, fetch: upstream as unknown as typeof fetch })
  try {
    const result = await post(broker.socket, "/v1/messages?beta=true", {
      authorization: "Bearer mikka-native-broker-placeholder", "anthropic-beta": "oauth-2025-04-20,fine-grained-tool-streaming", "anthropic-version": "2023-06-01", "content-type": "application/json", cookie: "session=1",
    }, '{"model":"m"}')
    expect(result).toEqual({ status: 200, text: '{"ok":true}' })
    const [url, init] = upstream.mock.calls[0]
    expect(url).toBe("https://llm.example.com/anthropic/v1/messages?beta=true")
    expect(init?.redirect).toBe("error")
    expect(init?.headers).toEqual({ "x-api-key": KEY, "anthropic-beta": "fine-grained-tool-streaming", "anthropic-version": "2023-06-01", "content-type": "application/json" })
    // Other paths never reach the provider, and the run's end stops the key.
    expect((await post(broker.socket, "/v1/files", {})).status).toBe(404)
    expect((await post(broker.socket, "/v1/messages?x=https://elsewhere", {})).status).toBe(404)
    live = false
    const refused = await post(broker.socket, "/v1/messages", {})
    expect(refused.status).toBe(502)
    expect(refused.text).not.toContain(KEY)
    expect(upstream).toHaveBeenCalledTimes(1)
  } finally { await broker.close() }
  await expect(post(broker.socket, "/v1/messages", {})).rejects.toThrow()
})

it("the cloud broker sends an OpenAI key as a bearer token to the Responses API", async () => {
  const upstream = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("data: {}\n\n", { status: 429, headers: { "content-type": "text/event-stream", "retry-after": "3" } }))
  const broker = await createApiKeyBroker({ root: tempDir(), protocol: "openai", credential: { kind: "api_key", key: KEY }, check: async () => undefined, fetch: upstream as unknown as typeof fetch })
  try {
    expect((await post(broker.socket, "/responses", { authorization: "Bearer mikka-native-broker-placeholder" })).status).toBe(429)
    const [url, init] = upstream.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/responses")
    expect(init?.headers).toEqual({ authorization: `Bearer ${KEY}` })
    expect((await post(broker.socket, "/v1/messages", {})).status).toBe(404)
  } finally { await broker.close() }
  await expect(createApiKeyBroker({ root: tempDir(), protocol: "openai", credential, check: async () => undefined })).rejects.toThrow("api_key_broker_unavailable")
})
