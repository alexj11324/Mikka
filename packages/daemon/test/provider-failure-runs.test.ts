import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { afterEach, expect, it, vi } from "vitest"

import { RUN_CHECKPOINT_MAX_BYTES, type RunCheckpoint } from "@mikka/protocol"
import { ProviderFailureError, type ProviderFailure } from "@mikka/protocol/provider-failure"
import { MockAdapter } from "../src/adapters/mock"
import type { StartOptions } from "../src/adapters/types"
import { Daemon } from "../src/main"
import { MemoryServer, type ServerLink } from "../src/server-link"
import { WorktreeManager } from "../src/worktrees"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"

const DEVICE = "provider-device"
const daemons: Daemon[] = []

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const daemon of daemons.splice(0)) await daemon.stop()
  cleanupTempDirs()
})

async function run(exit: Record<string, unknown>, afterStart?: (daemon: Daemon, runId: string) => Promise<void>,
  configureLink?: (link: ServerLink, server: MemoryServer) => void) {
  const server = new MemoryServer(DEVICE)
  server.addRepo(DEVICE, { repoId: "repo", name: "sandbox", path: await makeRepo() })
  const fixturesDir = tempDir()
  writeFileSync(join(fixturesDir, "provider.jsonl"), JSON.stringify({ t: 0, exit }) + "\n")
  const link = server.link()
  configureLink?.(link, server)
  const daemon = await new Daemon({
    dataDir: tempDir(), flavor: "dev", agentSandbox: null, link, credential: "cred",
    harnesses: [{ harness: "mock", installed: true, version: "test" }], mockSpeed: Infinity,
    heartbeatMs: 50, quotaSource: null, fixturesDir,
  }).start()
  daemons.push(daemon)
  await daemon.syncWithServer()
  const runId = server.queueRun(DEVICE, {
    issueId: "provider-issue", repoId: "repo", baseBranch: "main", harness: "mock", prompt: "do it", fixture: "provider",
  })
  await daemon.syncWithServer()
  await waitFor(() => daemon.supervisor.list().find(item => item.runId === runId))
  await afterStart?.(daemon, runId)
  await daemon.supervisor.idle()
  await waitFor(() => daemon.status().pendingUploads === 0)
  return { daemon, server, runId, run: daemon.supervisor.get(runId), completion: server.runs.get(runId)?.completion, checkpoint: server.runs.get(runId)?.checkpoint }
}

function pauseAdapterStart() {
  const starting = deferred<StartOptions>(), release = deferred()
  const start = MockAdapter.prototype.start
  vi.spyOn(MockAdapter.prototype, "start").mockImplementationOnce(async function (this: MockAdapter, options) {
    starting.resolve(options)
    await release.promise
    return start.call(this, options)
  })
  return { starting: starting.promise, release: () => release.resolve() }
}

const balanceFailure: ProviderFailure = { kind: "balance", retryable: false, status: 402, code: "payment_required" }
const providerStops = [
  { stopReason: "provider_failure", exit: { outcome: "failed", providerFailure: balanceFailure } },
  { stopReason: "quota_exhausted", exit: { outcome: "failed", quota: { resetsAt: null } } },
]

it.each<ProviderFailure>([
  { kind: "balance", retryable: false, status: 402, code: "insufficient_balance" },
  { kind: "auth", retryable: false, status: 401, code: "authentication_failed" },
  { kind: "unavailable", retryable: true, status: 503, code: "server_error" },
])("reports $kind separately and keeps even an empty worktree for continuation", async providerFailure => {
  const { daemon, runId, run: ended, completion } = await run({ outcome: "failed", error: "Model provider failed", providerFailure })
  expect(ended.stopReason).toBe("provider_failure")
  expect(completion).toMatchObject({ stopReason: "provider_failure", report: { providerFailure, providerCheckpoint: "ready", verify: { status: "not_run" } } })
  expect(existsSync(ended.worktree!)).toBe(true)
  expect(await daemon.supervisor.discardIfEmpty(runId)).toBe(false)
})

it("prefers the explicit provider receipt while preserving a quota reset", async () => {
  const providerFailure: ProviderFailure = { kind: "unavailable", retryable: true, status: 429, code: "rate_limit" }
  const { completion } = await run({ outcome: "failed", providerFailure, quota: { resetsAt: "2030-01-01T00:00:00.000Z" } })
  expect(completion).toMatchObject({ stopReason: "provider_failure", report: { providerFailure, resetsAt: "2030-01-01T00:00:00.000Z" } })
})

it.each([
  { outcome: "failed", error: "Build failed: HTTP 503; insufficient_balance" },
  { outcome: "failed", report: { summary: "Tool HTTP 402", providerFailure: { kind: "balance", retryable: false, status: 402 }, providerCheckpoint: "ready" } },
  { outcome: "failed", providerFailure: { kind: "balance", retryable: false, code: "private diagnostic" } },
])("does not infer provider failure from ordinary error text or agent reports", async exit => {
  const { completion } = await run(exit)
  expect(completion?.stopReason).toBe("error")
  expect(completion?.report.providerFailure).toBeUndefined()
  expect(completion?.report.providerCheckpoint).toBeUndefined()
})

it("keeps cancellation authoritative over a provider event", async () => {
  const { completion } = await run({ outcome: "cancelled", providerFailure: { kind: "unavailable", retryable: true, status: 503 } })
  expect(completion?.stopReason).toBe("cancelled")
  expect(completion?.report.providerFailure).toBeUndefined()
  expect(completion?.report.providerCheckpoint).toBeUndefined()
})

it("drops provider metadata when cancellation arrives while the terminal report is collected", async () => {
  const collecting = deferred(), release = deferred()
  vi.spyOn(WorktreeManager.prototype, "changedFiles").mockImplementationOnce(async () => {
    collecting.resolve()
    await release.promise
    return []
  })
  const { completion } = await run({ outcome: "failed", providerFailure: { kind: "balance", retryable: false, status: 402 } }, async (daemon, runId) => {
    await collecting.promise
    const cancelled = daemon.supervisor.cancel(runId)
    release.resolve()
    await cancelled
  })
  expect(completion?.stopReason).toBe("cancelled")
  expect(completion?.report.providerFailure).toBeUndefined()
  expect(completion?.report.providerCheckpoint).toBeUndefined()
})

it("retains a typed provider startup refusal through a hosted error wrapper", async () => {
  const providerFailure: ProviderFailure = { kind: "balance", retryable: false, status: 402, code: "payment_required" }
  vi.spyOn(MockAdapter.prototype, "start").mockRejectedValue(new Error("Hosted startup failed", { cause: new ProviderFailureError(providerFailure) }))
  const { completion } = await run({ outcome: "succeeded" })
  expect(completion).toMatchObject({ stopReason: "provider_failure", report: { providerFailure, providerCheckpoint: "ready" } })
})

it("does not classify a generic startup exception carrying an HTTP status", async () => {
  vi.spyOn(MockAdapter.prototype, "start").mockRejectedValue(Object.assign(new Error("Repository HTTP 503"), { status: 503 }))
  const { completion } = await run({ outcome: "succeeded" })
  expect(completion?.stopReason).toBe("error")
  expect(completion?.report.providerFailure).toBeUndefined()
})

it.each(providerStops)("confirms an empty first-request snapshot before publishing $stopReason", async ({ stopReason, exit }) => {
  const uploading = deferred<RunCheckpoint>(), release = deferred()
  const order: string[] = []
  let server!: MemoryServer
  const { completion, checkpoint } = await run(exit, async (_daemon, runId) => {
    try {
      const snapshot = await uploading.promise
      expect(snapshot.baseCommit).toMatch(/^[a-f0-9]{40}$/)
      expect(snapshot.files).toBe(0)
      expect(gunzipSync(Buffer.from(snapshot.patch, "base64")).length).toBe(0)
      expect(server.runs.get(runId)?.completion).toBeUndefined()
    } finally { release.resolve() }
  }, (link, memory) => {
    server = memory
    const save = link.checkpointRun!, complete = link.completeRun
    link.checkpointRun = async (runId, snapshot) => {
      order.push("upload")
      uploading.resolve(snapshot)
      await release.promise
      const receipt = await save(runId, snapshot)
      order.push("confirmed")
      return receipt
    }
    link.completeRun = async (runId, report) => {
      order.push("complete")
      await complete(runId, report)
    }
  })
  expect(order).toEqual(["upload", "confirmed", "complete"])
  expect(completion?.stopReason).toBe(stopReason)
  expect(checkpoint?.files).toBe(0)
  expect(completion?.report.providerCheckpoint).toBe("ready")
  if (stopReason === "quota_exhausted") {
    expect(completion?.report.providerFailure).toBeUndefined()
    expect(completion?.report.resetsAt).toBeNull()
  }
})

it("marks a failed final upload unavailable and continues only with the retained original worktree", async () => {
  const paused = pauseAdapterStart()
  let link!: ServerLink
  let uploads = 0
  const { daemon, server, runId, completion, checkpoint, run: ended } = await run({ outcome: "failed", providerFailure: balanceFailure, report: { providerCheckpoint: "ready" } }, async (daemon, runId) => {
    try {
      const start = await paused.starting
      writeFileSync(join(start.cwd, "draft.txt"), "previous work\n")
      await daemon.supervisor.saveCheckpoints((id, snapshot) => link.checkpointRun!(id, snapshot), Date.now() + 180_000)
      writeFileSync(join(start.cwd, "draft.txt"), "final work that must not be lost\n")
      expect(daemon.supervisor.get(runId).state).not.toBe("failed")
    } finally { paused.release() }
  }, connection => {
    link = connection
    const save = link.checkpointRun!
    link.checkpointRun = async (runId, snapshot) => {
      if (++uploads === 2) throw new Error("Controlled final checkpoint upload failure")
      return save(runId, snapshot)
    }
  })
  expect(uploads).toBe(2)
  expect(gunzipSync(Buffer.from(checkpoint!.patch, "base64")).toString()).toContain("previous work")
  expect(completion).toMatchObject({ stopReason: "provider_failure", report: { providerCheckpoint: "unavailable" } })
  expect(existsSync(ended.worktree!)).toBe(true)
  const continuationId = server.queueRun(DEVICE, {
    issueId: "provider-issue", repoId: "repo", baseBranch: "main", harness: "mock", prompt: "continue", fixture: "provider",
    continuesRunId: runId, requireWorktreeContinuation: true,
  })
  await daemon.syncWithServer()
  await waitFor(() => daemon.supervisor.list().find(item => item.runId === continuationId))
  await daemon.supervisor.idle()
  await waitFor(() => daemon.status().pendingUploads === 0)
  expect(daemon.supervisor.get(continuationId).worktree).toBe(ended.worktree)
  expect(readFileSync(join(ended.worktree!, "draft.txt"), "utf8")).toBe("final work that must not be lost\n")
  expect(server.runs.get(continuationId)?.completion?.report.providerCheckpoint).toBe("ready")
})

it("waits for an in-flight heartbeat before saving the final tree", async () => {
  const paused = pauseAdapterStart()
  const uploading = deferred(), releaseUpload = deferred()
  let link!: ServerLink
  const uploaded: RunCheckpoint[] = []
  const { completion, checkpoint } = await run({ outcome: "failed", providerFailure: balanceFailure }, async (daemon, runId) => {
    let heartbeat: Promise<void> | undefined
    try {
      const start = await paused.starting
      writeFileSync(join(start.cwd, "draft.txt"), "previous work\n")
      heartbeat = daemon.supervisor.saveCheckpoints((id, snapshot) => link.checkpointRun!(id, snapshot), Date.now() + 180_000)
      await uploading.promise
      writeFileSync(join(start.cwd, "draft.txt"), "final work\n")
      paused.release()
      // The first upload remains in flight while the adapter ends. Final
      // completion cannot race ahead of that older authenticated write.
      await waitFor(() => daemon.supervisor.get(runId).state === "running")
      expect(uploaded).toHaveLength(0)
    } finally {
      paused.release()
      releaseUpload.resolve()
      await heartbeat
    }
  }, connection => {
    link = connection
    const save = link.checkpointRun!
    link.checkpointRun = async (runId, snapshot) => {
      if (!uploaded.length) {
        uploading.resolve()
        await releaseUpload.promise
      }
      const receipt = await save(runId, snapshot)
      uploaded.push(snapshot)
      return receipt
    }
  })
  expect(uploaded).toHaveLength(2)
  expect(gunzipSync(Buffer.from(uploaded[0]!.patch, "base64")).toString()).toContain("previous work")
  expect(gunzipSync(Buffer.from(checkpoint!.patch, "base64")).toString()).toContain("final work")
  expect(completion?.report.providerCheckpoint).toBe("ready")
})

it.each(providerStops)("keeps repeated cancellation authoritative while the $stopReason checkpoint is uploading", async ({ exit }) => {
  const uploading = deferred(), release = deferred()
  const { completion } = await run(exit, async (daemon, runId) => {
    await uploading.promise
    const cancelled = Promise.all([daemon.supervisor.cancel(runId), daemon.supervisor.cancel(runId)])
    release.resolve()
    await cancelled
  }, link => {
    const save = link.checkpointRun!
    link.checkpointRun = async (runId, snapshot) => {
      uploading.resolve()
      await release.promise
      return save(runId, snapshot)
    }
  })
  expect(completion?.stopReason).toBe("cancelled")
  expect(completion?.report.providerFailure).toBeUndefined()
  expect(completion?.report.providerCheckpoint).toBeUndefined()
})

it("cannot claim a ready checkpoint when startup has not prepared a worktree", async () => {
  vi.spyOn(WorktreeManager.prototype, "create").mockRejectedValueOnce(new ProviderFailureError(balanceFailure))
  const { completion, checkpoint } = await run({ outcome: "succeeded" })
  expect(completion).toMatchObject({ stopReason: "provider_failure", report: { providerCheckpoint: "unavailable" } })
  expect(checkpoint).toBeUndefined()
})

it("records an accepted oversize marker as unavailable instead of recoverable", async () => {
  const paused = pauseAdapterStart()
  const { completion, checkpoint } = await run({ outcome: "failed", providerFailure: balanceFailure }, async () => {
    try {
      const start = await paused.starting
      writeFileSync(join(start.cwd, "large.bin"), randomBytes(RUN_CHECKPOINT_MAX_BYTES + 2 * 1024 * 1024))
    } finally { paused.release() }
  })
  expect(checkpoint?.unavailableReason).toBe("too_large")
  expect(completion?.report.providerCheckpoint).toBe("unavailable")
})
