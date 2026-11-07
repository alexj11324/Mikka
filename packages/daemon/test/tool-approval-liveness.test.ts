// A run's machine-local gate, end to end through the real HttpServerLink and
// Claude SDK protocol. Policy/owner changes stop the run through existing
// run-control commands or heartbeat leases, never an operation-time auth RPC.
import { chmodSync, existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { resolveAgentSettings } from "@mikka/protocol/agent-policy"
import { afterEach, expect, it, vi } from "vitest"

import { NoSandbox } from "../src/agents/sandbox"
import { ToolApprovalGate } from "../src/agents/tool-approval"
import { Daemon } from "../src/main"
import { MemoryServer } from "../src/server-link"
import { HttpServerLink } from "../src/server-link-http"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"

const CLAUDE = join(resolve(import.meta.dirname, "fakes"), "fake-claude.mjs")
chmodSync(CLAUDE, 0o755)
const DEVICE = "device-fake"
const REVISION = "a".repeat(64)
const daemons: Daemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  cleanupTempDirs()
})

/** `answer` is the tool-approval route's reply to each check. */
async function boot(answer: (body: { policyRevision: string }) => Response | Promise<Response>, prompt = "HANG") {
  const server = new MemoryServer(DEVICE, { leaseMs: 90_000 })
  server.addRepo(DEVICE, { repoId: "repo", name: "sandbox", path: await makeRepo() })
  const checks: string[] = []
  const http = new HttpServerLink("http://server.test", (async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith("/policy-snapshot")) return new Response(null, { status: 404 })
    if (!path.endsWith("/tool-approval")) throw new Error(`unexpected ${path}`)
    const body = JSON.parse(String(init?.body)) as { policyRevision: string }
    checks.push(body.policyRevision)
    return answer(body)
  }) as typeof fetch)
  const link = server.link()
  let gate: ToolApprovalGate | undefined
  link.prepareRunToolApproval = async (assignment, signal, check) => {
    gate = await http.prepareRunToolApproval({ ...assignment, policyRevision: REVISION }, signal, check)
    return gate
  }
  const daemon = await new Daemon({
    dataDir: tempDir(), flavor: "dev", link, credential: "cred", heartbeatMs: 50,
    harnesses: [{ harness: "claude_code", installed: true, version: "fake" }],
    agentSandbox: new NoSandbox(), harnessBinaries: { claude_code: CLAUDE },
  }).start()
  daemons.push(daemon)
  await daemon.syncWithServer()
  const runId = server.queueRun(DEVICE, { issueId: "issue-1", repoId: "repo", baseBranch: "main", harness: "claude_code", prompt, policy: resolveAgentSettings({}).policy })
  await daemon.syncWithServer()
  await waitFor(() => daemon.supervisor.get(runId).state === "running")
  return { daemon, runId, checks, server, gate: gate! }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it("coalesces only in-flight liveness checks and never caches a settled success", async () => {
  const pending = deferred<boolean>()
  const host = { isLive: vi.fn(() => pending.promise) }
  const gate = new ToolApprovalGate("run-a", host)
  const waiters = Array.from({ length: 12 }, () => gate.checkLive())
  await Promise.resolve()
  expect(host.isLive).toHaveBeenCalledTimes(1)
  pending.resolve(true)
  expect(await Promise.all(waiters)).toEqual(Array(12).fill(true))
  expect(await gate.checkLive()).toBe(true)
  expect(host.isLive).toHaveBeenCalledTimes(2)
})

it("releases all pending waiters on revocation and an old success cannot revive the gate", async () => {
  const pending = deferred<boolean>()
  const host = { isLive: vi.fn(() => pending.promise) }
  const gate = new ToolApprovalGate("run-a", host)
  const waiters = Array.from({ length: 5 }, () => gate.checkLive())
  await Promise.resolve()
  gate.revoke()
  expect(await Promise.all(waiters)).toEqual(Array(5).fill(false))
  pending.resolve(true)
  expect(await gate.checkLive()).toBe(false)
  expect(host.isLive).toHaveBeenCalledTimes(1)
})

it("checks the host again after false or rejected checks and fails closed on a synchronous throw", async () => {
  const host = { isLive: vi.fn<() => boolean | Promise<boolean>>()
    .mockReturnValueOnce(false)
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockImplementationOnce(() => { throw new Error("synchronous failure") })
    .mockReturnValueOnce(true) }
  const gate = new ToolApprovalGate("run-a", host)
  expect(await gate.checkLive()).toBe(false)
  expect(await gate.checkLive()).toBe(false)
  expect(await gate.checkLive()).toBe(false)
  expect(await gate.checkLive()).toBe(true)
  expect(host.isLive).toHaveBeenCalledTimes(4)
})

it("does not share an in-flight check across gates or run identities", async () => {
  const pending = deferred<boolean>()
  const host = { isLive: vi.fn(() => pending.promise) }
  const gates = [new ToolApprovalGate("run-a", host), new ToolApprovalGate("run-a", host), new ToolApprovalGate("run-b", host)]
  const waiters = gates.map(gate => gate.checkLive())
  await Promise.resolve()
  expect(host.isLive.mock.calls).toEqual([["run-a"], ["run-a"], ["run-b"]])
  pending.resolve(true)
  expect(await Promise.all(waiters)).toEqual([true, true, true])
})

it("ends a running run through an existing stop command without querying remote tool authority", async () => {
  const { daemon, runId, checks, server } = await boot(() => { throw Error('No operation-time auth RPC is allowed') })
  expect(daemon.supervisor.get(runId).state).toBe("running")
  server.requestStop(runId)
  await daemon.supervisor.idle()
  expect(daemon.supervisor.get(runId)).toMatchObject({ state: "cancelled", stopReason: "cancelled" })
  expect(checks).toEqual([])
}, 20_000)

it("records heartbeat lease revocation before the native Claude process exits 143", async () => {
  const exited = join(tempDir(), 'sigterm-exit')
  const { daemon, runId, server, checks } = await boot(() => json({ live: true }), `HANG SIGTERM_EXIT_143:${exited}`)
  await waitFor(() => existsSync(`${exited}.ready`))
  server.runs.get(runId)!.state = 'failed'
  await daemon.syncWithServer()
  await daemon.supervisor.idle()
  expect(readFileSync(exited, 'utf8')).toBe('143\n')
  expect(daemon.supervisor.get(runId)).toMatchObject({ state: 'failed', stopReason: 'device_lost' })
  expect(checks).toEqual([])
}, 20_000)

it("keeps an unclassified SIGTERM 143 as error instead of inventing lease revocation", async () => {
  const exited = join(tempDir(), 'sigterm-exit')
  const { daemon, runId, gate, checks } = await boot(() => json({ live: true }), `HANG SIGTERM_EXIT_143:${exited}`)
  await waitFor(() => existsSync(`${exited}.ready`))
  gate.revoke()
  await daemon.supervisor.idle()
  expect(readFileSync(exited, 'utf8')).toBe('143\n')
  expect(daemon.supervisor.get(runId)).toMatchObject({ state: 'failed', stopReason: 'error' })
  expect(checks).toEqual([])
}, 20_000)

it("a late lease-revocation notification cannot replace the person's earlier cancellation", async () => {
  const pending = deferred<void>()
  const { daemon, runId, gate, checks } = await boot(() => json({ live: true }))
  const notification = pending.promise.then(() => gate.revoke('device_lost'))
  const cancelled = daemon.supervisor.cancel(runId)
  pending.resolve()
  await notification
  await cancelled
  expect(daemon.supervisor.get(runId)).toMatchObject({ state: 'cancelled', stopReason: 'cancelled' })
  expect(checks).toEqual([])
}, 20_000)

it("a gate keeps its first host cause through synchronous abort callbacks", () => {
  const gate = new ToolApprovalGate('run-cause', { isLive: () => true })
  const abort = new AbortController()
  abort.signal.addEventListener('abort', () => gate.revoke())
  gate.onRevoke(() => abort.abort())
  gate.revoke('device_lost')
  expect(gate.revokeReason).toBe('device_lost')
  const cancelled = new ToolApprovalGate('run-cancelled', { isLive: () => true })
  cancelled.revoke()
  cancelled.revoke('device_lost')
  expect(cancelled.revokeReason).toBeUndefined()
})

it("keeps execution independent of an unavailable legacy liveness route", async () => {
  let failed = 0
  const { daemon, runId, gate, checks } = await boot(async () => {
    failed++
    throw new DOMException("The operation timed out.", "TimeoutError")
  })
  for (let i = 0; i < 100; i++) expect(await gate.checkLive()).toBe(true)
  expect(failed).toBe(0)
  expect(checks).toEqual([])
  expect(daemon.supervisor.get(runId).state).toBe("running")
  await daemon.supervisor.cancel(runId)
  expect(daemon.supervisor.get(runId)).toMatchObject({ state: "cancelled", stopReason: "cancelled" })
}, 20_000)
