import { join } from "node:path"
import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { captureRunFailure, RunFailureError } from "@mikka/protocol/run-failure"
import type { AgentAdapter, AgentSession, ExitEvent } from "../adapters/types"
import { RunSupervisor } from "./supervisor"
import { RunJournal } from "./journal"
import { WorktreeManager } from "../worktrees"
import { Outbox } from "../outbox"
import { MemoryServer } from "../server-link"
import { createLogger } from "../log"
import { cleanupTempDirs, makeRepo, tempDir } from "../../test/helpers"

const resources: { supervisor: RunSupervisor; outbox: Outbox }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const resource of resources.splice(0)) { await resource.supervisor.stop(); await resource.outbox.close() }
  cleanupTempDirs()
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(exit: Omit<ExitEvent, "type">) {
  const root = tempDir(), repo = { repoId: "repo", name: "fixture", path: await makeRepo() }
  const server = new MemoryServer("device"), link = server.link(), log = createLogger({ level: "silent" })
  server.addRepo("device", repo)
  const runId = server.queueRun("device", { issueId: "issue", repoId: "repo", baseBranch: "main", harness: "mock", prompt: "private task instructions", taskEnv: { SERVICE_SECRET: "opaque-task-secret" }, taskSecretNames: ["SERVICE_SECRET"] })
  const assignment = await link.claimRun("device", runId)
  const session: AgentSession = { sessionId: "fixture", async *events() { yield { type: "exit", ...exit } }, send: async () => {}, cancel: async () => {} }
  const adapter: AgentAdapter = { harness: "mock", capabilities: { supportsInterject: false, supportsResume: true }, envAllow: [], start: vi.fn(async () => session), resume: vi.fn(async () => session) }
  const journal = new RunJournal(join(root, "runs.json")), outboxDir = join(root, "outbox")
  const outbox = new Outbox(outboxDir, link, log, 60_000), worktrees = new WorktreeManager(join(root, "worktrees"))
  const supervisor = new RunSupervisor({ journal, outbox, worktrees, adapters: new Map([["mock", adapter]]), repository: () => repo, prepareRepository: async () => {}, baseRef: async () => "main", log })
  resources.push({ supervisor, outbox })
  return { root, server, link, log, runId, assignment, supervisor, adapter, journal, outbox, outboxDir, worktrees }
}
const failure = captureRunFailure({ provider: "openai", status: 429, error: { code: "insufficient_quota", message: "Account exhausted. opaque-task-secret" } }, { runId: "original", appVersion: "1.2.3", occurredAt: "2026-11-01T00:00:00.000Z" })

it('refuses an isolation-required assignment before an unsupported adapter or bootstrap can execute', async () => {
  const f = await fixture({ outcome: 'succeeded' })
  const bootstrap = vi.spyOn(f.worktrees, 'bootstrap')
  f.supervisor.start({ ...f.assignment, nativeCredentialIsolation: 'tools_v1' })
  await f.supervisor.idle()
  expect(f.adapter.start).not.toHaveBeenCalled()
  expect(bootstrap).not.toHaveBeenCalled()
  expect(f.journal.get(f.runId)?.state).toBe('failed')
})

it('persists measured tool durations before outbox batching and keeps task secrets masked', async () => {
  const f = await fixture({ outcome: 'succeeded' })
  vi.mocked(f.adapter.start).mockResolvedValueOnce({
    sessionId: 'timed-tools', send: async () => {}, cancel: async () => {},
    async *events() {
      yield { type: 'chunk', chunk: { type: 'tool-input-available', toolCallId: 'cmd', toolName: 'bash', input: { command: 'print result' } } }
      yield { type: 'chunk', chunk: { type: 'tool-output-available', toolCallId: 'cmd', output: 'opaque-task-secret' } }
      yield { type: 'exit', outcome: 'succeeded' }
    },
  })
  f.server.online = false
  f.supervisor.start(f.assignment)
  await f.supervisor.idle()
  await f.outbox.close()
  const persisted = readFileSync(join(f.outboxDir, `${f.runId}.jsonl`), 'utf8')
  expect(persisted).not.toContain('opaque-task-secret')
  expect(persisted).toContain('[secret:SERVICE_SECRET]')
  expect(persisted).toMatch(/"toolDurationMs":\d+/)
})

describe("supervisor structured terminal failures", () => {
  it("carries adapter details through masking, disk persistence and a fresh outbox replay", async () => {
    const f = await fixture({ outcome: "failed", error: "Provider failed", failureDetails: failure })
    f.server.online = false
    f.supervisor.start(f.assignment)
    await f.supervisor.idle()
    await f.outbox.close()
    const persisted = readFileSync(join(f.outboxDir, `${f.runId}.jsonl`), "utf8")
    expect(persisted).not.toContain("opaque-task-secret")
    expect(persisted).toContain("run_quota_exceeded")
    f.server.online = true
    const replay = new Outbox(f.outboxDir, f.link, f.log)
    try { await replay.flushAll() } finally { await replay.close() }
    expect(f.server.runs.get(f.runId)?.completion?.failureDetails).toMatchObject({ category: "quota", status: 429, occurredAt: failure.occurredAt, providerMessage: expect.stringContaining("Account exhausted") })
  })
  it("retains captured startup details through a cause wrapper", async () => {
    const f = await fixture({ outcome: "succeeded" })
    const logged = vi.spyOn(f.log, "error")
    vi.mocked(f.adapter.start).mockRejectedValueOnce(new Error("Startup failed", { cause: new RunFailureError(failure, { cause: new Error("opaque-task-secret private task instructions") }) }))
    f.supervisor.start(f.assignment)
    await f.supervisor.idle(); await f.outbox.flushAll()
    expect(f.server.runs.get(f.runId)?.completion?.failureDetails).toMatchObject({ code: "run_quota_exceeded", occurredAt: failure.occurredAt })
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ code: "run_quota_exceeded", causes: expect.any(Array) }) }), "run failed")
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/opaque-task-secret|private task instructions/)
  })
  it.each(["cancel", "lease"] as const)("drops provider details when %s wins during terminal collection", async mode => {
    const f = await fixture({ outcome: "failed", error: "Provider failed", failureDetails: failure })
    const collecting = deferred(), release = deferred()
    vi.spyOn(f.worktrees, "changedFiles").mockImplementationOnce(async () => { collecting.resolve(); await release.promise; return [] })
    f.supervisor.start(f.assignment)
    await collecting.promise
    const cancelled = mode === "cancel" ? f.supervisor.cancel(f.runId) : (f.supervisor.check(Date.now() + 3_600_000), Promise.resolve())
    release.resolve()
    await cancelled; await f.supervisor.idle(); await f.outbox.flushAll()
    expect(f.server.runs.get(f.runId)?.completion).toMatchObject({ stopReason: mode === "cancel" ? "cancelled" : "device_lost" })
    expect(f.server.runs.get(f.runId)?.completion?.failureDetails).toBeUndefined()
  })
  it("does not accept failure details from a model handoff", async () => {
    const f = await fixture({ outcome: "failed", report: { summary: "Tool failed", failureDetails: failure } as unknown as ExitEvent["report"] })
    f.supervisor.start(f.assignment)
    await f.supervisor.idle(); await f.outbox.flushAll()
    const completion = f.server.runs.get(f.runId)?.completion
    expect(completion?.failureDetails?.code).toBe("run_failed")
    expect(completion?.report).not.toHaveProperty("failureDetails")
  })
  it("gives a pre-launch refusal the registered error details", async () => {
    const f = await fixture({ outcome: "succeeded" })
    expect(() => f.supervisor.start({ ...f.assignment, harness: "codex" })).toThrow()
    await f.outbox.flushAll()
    expect(f.server.runs.get(f.runId)?.completion).toMatchObject({ stopReason: "error", failureDetails: { schemaVersion: 1, runId: f.runId } })
    expect(f.adapter.start).not.toHaveBeenCalled()
  })
  it("captures a restart refusal when the API credential was intentionally not persisted", async () => {
    const f = await fixture({ outcome: "succeeded" })
    f.journal.put({ assignment: f.assignment, state: "running", sessionId: "previous", worktree: null, lastSeq: 0, error: null, updatedAt: new Date().toISOString(), credentialWithheld: true })
    await f.supervisor.resumeAll(); await f.outbox.flushAll()
    expect(f.server.runs.get(f.runId)?.completion).toMatchObject({ stopReason: "error", failureDetails: { schemaVersion: 1, runId: f.runId, code: "run_failed" } })
    expect(f.adapter.resume).not.toHaveBeenCalled()
  })
})
