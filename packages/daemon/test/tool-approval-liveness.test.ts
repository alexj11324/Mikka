// A run's liveness gate, end to end in the daemon: the real HttpServerLink
// gate against a scripted tool-approval route, driving a fake Claude Code run.
// The server half (a changed policy revision answers live:false) runs against
// real Postgres in lib/agent-tool-approval/http.db.test.mts.
import { chmodSync } from "node:fs"
import { join, resolve } from "node:path"

import { resolveAgentSettings } from "@mikka/protocol/agent-policy"
import { afterEach, expect, it } from "vitest"

import { NoSandbox } from "../src/agents/sandbox"
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
async function boot(answer: (body: { policyRevision: string }) => Response | Promise<Response>) {
  const server = new MemoryServer(DEVICE)
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
  const runId = server.queueRun(DEVICE, { issueId: "issue-1", repoId: "repo", baseBranch: "main", harness: "claude_code", prompt: "HANG", policy: resolveAgentSettings({}).policy })
  await daemon.syncWithServer()
  await waitFor(() => daemon.supervisor.get(runId).state === "running")
  return { daemon, runId, checks }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

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
