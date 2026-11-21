// A run's own API key (`modelCredential`): it reaches the run's Agent in
// memory only, is never written to the journal, a restarted daemon does not
// run on without it.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { RunAssignment } from "@mikka/protocol"
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
   quotaSource: null,
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
