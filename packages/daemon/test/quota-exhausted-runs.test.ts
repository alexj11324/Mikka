// A run whose CLI says its subscription's quota ran out ends `quota_exhausted`
// with the reset time and keeps its worktree for the continuation. On an API
// key the same failure is an ordinary error, and other failures are unchanged.
import { existsSync } from "node:fs"
import { afterEach, expect, it } from "vitest"
import { Daemon } from "../src/main"
import { MemoryServer } from "../src/server-link"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"

const DEVICE = "device-1"
const daemons: Daemon[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  cleanupTempDirs()
})

async function setup() {
  const repo = await makeRepo()
  const server = new MemoryServer(DEVICE)
  server.addRepo(DEVICE, { repoId: "repo-1", name: "sandbox", path: repo })
  const daemon = await new Daemon({
    dataDir: tempDir(), flavor: "dev", agentSandbox: null, link: server.link(), credential: "cred-1",
    harnesses: [{ harness: "mock", installed: true, version: "test" }], mockSpeed: Number.POSITIVE_INFINITY,
    heartbeatMs: 50, quotaSource: null,
  }).start()
  daemons.push(daemon)
  await daemon.syncWithServer()
  return { server, daemon }
}

async function runToEnd(server: MemoryServer, daemon: Daemon, fixture: string, extra: Record<string, unknown> = {}) {
  const runId = server.queueRun(DEVICE, { issueId: `issue-${fixture}`, repoId: "repo-1", baseBranch: "main", harness: "mock", prompt: "do it", fixture, ...extra })
  await daemon.syncWithServer()
  await waitFor(() => daemon.supervisor.list().find(run => run.runId === runId))
  await daemon.supervisor.idle()
  await waitFor(() => daemon.status().pendingUploads === 0)
  return { runId, run: daemon.supervisor.get(runId), completion: server.runs.get(runId)?.completion }
}

it("a subscription run reports quota_exhausted with the CLI's reset and keeps its worktree", async () => {
  const { server, daemon } = await setup()
  const { run, completion } = await runToEnd(server, daemon, "quota-exhausted")
  expect(completion?.stopReason).toBe("quota_exhausted")
  expect(completion?.report.resetsAt).toBe("2025-11-01T17:00:00.000Z")
  expect(run.stopReason).toBe("quota_exhausted")
  expect(existsSync(run.worktree as string)).toBe(true)
})

it("an API-key run's rate limit is an ordinary error, not quota_exhausted", async () => {
  const { server, daemon } = await setup()
  const { completion } = await runToEnd(server, daemon, "quota-exhausted", {
    modelCredential: { kind: "provider", protocol: "anthropic", baseUrl: "https://llm.example.com/anthropic", key: "fixture-model-key-0123456789abcdef" },
  })
  expect(completion?.stopReason).toBe("error")
  expect(completion?.report.resetsAt).toBeUndefined()
})

it("other failures keep their stop reason", async () => {
  const { server, daemon } = await setup()
  expect((await runToEnd(server, daemon, "failure")).completion?.stopReason).toBe("error")
  expect((await runToEnd(server, daemon, "quota")).completion?.stopReason).toBe("blocked")
})
