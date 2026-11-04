// A run's liveness gate, end to end in the daemon: the real HttpServerLink
// gate against a scripted tool-approval route, driving a fake Claude Code run.
// The server half (a changed policy revision answers live:false) runs against
// real Postgres in lib/agent-tool-approval/http.db.test.mts.
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
  link.prepareRunToolApproval = (assignment, signal, check) => http.prepareRunToolApproval({ ...assignment, policyRevision: REVISION }, signal, check)
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
  return { daemon, runId, checks }
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

it("ends a running run when the server says its policy revision is no longer live", async () => {
  let live = true
  const { daemon, runId, checks } = await boot(() => json({ live, paused: false }))
  await waitFor(() => checks.length > 0)
  expect(daemon.supervisor.get(runId).state).toBe("running")
  live = false
  await daemon.supervisor.idle()
  // The revoked gate stops the CLI (SIGTERM on a direct spawn). A hosted run
  // (subscription-hosted-runner) cancels its session instead and ends cancelled.
  expect(daemon.supervisor.get(runId)).toMatchObject({ state: "failed", stopReason: "error" })
  expect(daemon.supervisor.get(runId).error).toMatch(/SIGTERM/)
  expect(checks.every(revision => revision === REVISION)).toBe(true)
}, 20_000)

it("records host lease revocation before Claude exits 143, even before the heartbeat learns it", async () => {
  const exited = join(tempDir(), 'sigterm-exit')
  let revoked = false
  const { daemon, runId } = await boot(() => json(revoked
    ? { live: false, revokeReason: 'device_lost' }
    : { live: true, paused: false }), `HANG SIGTERM_EXIT_143:${exited}`)
  await waitFor(() => existsSync(`${exited}.ready`))
  revoked = true
  await daemon.supervisor.idle()
  expect(readFileSync(exited, 'utf8')).toBe('143\n')
  expect(daemon.supervisor.get(runId)).toMatchObject({ state: 'failed', stopReason: 'device_lost' })
}, 20_000)

it("keeps an unclassified SIGTERM 143 as error instead of inventing lease revocation", async () => {
  const exited = join(tempDir(), 'sigterm-exit')
  let live = true
  const { daemon, runId } = await boot(() => json({ live, paused: false }), `HANG SIGTERM_EXIT_143:${exited}`)
  await waitFor(() => existsSync(`${exited}.ready`))
  live = false
  await daemon.supervisor.idle()
  expect(readFileSync(exited, 'utf8')).toBe('143\n')
  expect(daemon.supervisor.get(runId)).toMatchObject({ state: 'failed', stopReason: 'error' })
}, 20_000)

it("a pending host response cannot replace the person's earlier cancellation", async () => {
  const pending = deferred<Response>()
  let wait = false, requested = false
  const { daemon, runId } = await boot(() => {
    if (!wait) return json({ live: true, paused: false })
    requested = true
    return pending.promise
  })
  wait = true
  await waitFor(() => requested)
  const cancelled = daemon.supervisor.cancel(runId)
  pending.resolve(json({ live: false, revokeReason: 'device_lost' }))
  await cancelled
  expect(daemon.supervisor.get(runId)).toMatchObject({ state: 'cancelled', stopReason: 'cancelled' })
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

it("keeps a running run through a slow cold start of the liveness route", async () => {
  let slow = false, failed = 0
  const { daemon, runId, checks } = await boot(async () => {
    if (!slow) return json({ live: true, paused: false })
    failed++
    throw new DOMException("The operation timed out.", "TimeoutError")
  })
  slow = true
  await waitFor(() => failed >= 3)
  expect(daemon.supervisor.get(runId).state).toBe("running")
  slow = false
  const answered = checks.length
  await waitFor(() => checks.length > answered + 1)
  expect(daemon.supervisor.get(runId).state).toBe("running")
  await daemon.supervisor.cancel(runId)
  expect(daemon.supervisor.get(runId)).toMatchObject({ state: "cancelled", stopReason: "cancelled" })
}, 20_000)
