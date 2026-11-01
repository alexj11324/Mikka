// Regression tests for the daemon review: path escapes through server ids,
// self-reported verify, stop() with a session that never yields, claimed
// runs without an adapter, and the data dir lock.
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { HarnessInfo } from "@mikka/protocol"
import { defaultRunPolicy } from "@mikka/protocol/agent-policy"

import { InvalidIdError } from "../src/errors"
import { SandboxRuntime } from "../src/agents/sandbox"
import { acquireLock, DaemonAlreadyRunningError } from "../src/lock"
import { Daemon } from "../src/main"
import { daemonPaths } from "../src/paths"
import { RpcServer } from "../src/rpc/server"
import { MemoryServer } from "../src/server-link"
import { HttpServerLink, seg } from "../src/server-link-http"
import { runBranch, WorktreeManager } from "../src/worktrees"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"

const DEVICE = "device-1"
const daemons: Daemon[] = []

async function boot(
  server: MemoryServer,
  dataDir: string,
  options: Partial<ConstructorParameters<typeof Daemon>[0]> = {}
) {
  const daemon = await new Daemon({
    dataDir,
    flavor: "dev",
    link: server.link(),
    credential: "cred-1",
    harnesses: [{ harness: "mock", installed: true, version: "test" }],
    mockSpeed: Number.POSITIVE_INFINITY,
    heartbeatMs: 50,
    quotaSource: null,
    ...options,
  }).start()
  daemons.push(daemon)
  await daemon.syncWithServer()
  return daemon
}

async function setup() {
  const repo = await makeRepo()
  const server = new MemoryServer(DEVICE)
  server.addRepo(DEVICE, { repoId: "repo-1", name: "sandbox", path: repo })
  return { repo, server, dataDir: tempDir() }
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  cleanupTempDirs()
})

describe("server ids never leave the daemon's dirs", () => {
  it("refuses unsafe run ids in paths and branches", () => {
    const worktrees = new WorktreeManager(tempDir())
    for (const id of ["..", "../victim", "a/b", "", "x".repeat(65), "a b"]) {
      expect(() => worktrees.pathFor(id)).toThrow()
      expect(() => runBranch(id)).toThrow()
    }
    expect(worktrees.pathFor("run-1_A")).toMatch(/run-1_A$/)
  })

  it("escapes ids in HTTP routes and refuses dot segments", async () => {
    expect(() => seg("..")).toThrow(InvalidIdError)
    expect(() => seg(".")).toThrow(InvalidIdError)
    expect(seg("a/../b")).toBe("a%2F..%2Fb")
    const urls: string[] = []
    const link = new HttpServerLink("http://server.invalid", async (url) => {
      urls.push(String(url))
      return new Response(null, { status: 204 })
    })
    await link.updateRun("../devices/x", { state: "running" })
    expect(urls).toEqual(["http://server.invalid/v1/runs/..%2Fdevices%2Fx"])
  })

  it("refuses a queued run whose id would escape, without touching disk", async () => {
    const { server, dataDir } = await setup()
    // A sibling of the worktrees dir that an escaping id would point at.
    const victim = join(dataDir, "victim")
    mkdirSync(victim)
    writeFileSync(join(victim, "keep.txt"), "keep")
    const runId = server.queueRun(DEVICE, {
      runId: "../victim",
      issueId: "issue-escape",
      repoId: "repo-1",
      baseBranch: "main",
      harness: "mock",
      prompt: "p",
    })
    const daemon = await boot(server, dataDir, { retentionMs: 0 })
    await daemon.syncWithServer()

    expect(daemon.supervisor.list()).toEqual([])
    expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep")
    // Reported once as an error completion; never claimed.
    expect(server.runs.get(runId)?.completion).toMatchObject({
      stopReason: "error",
    })
    expect(server.runs.get(runId)?.state).toBe("queued")
  })
})

describe("verify is the daemon's, never the agent's", () => {
  it("ignores a self-reported verify; an unverified submit does not succeed", async () => {
    const { repo, server, dataDir } = await setup()
    const initialHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()
    const daemon = await boot(server, dataDir)
    const runId = server.queueRun(DEVICE, {
      issueId: "issue-self-verify",
      repoId: "repo-1",
      baseBranch: "main",
      harness: "mock",
      prompt: "p",
      fixture: "self-verify",
      // No verify command: nothing the daemon ran can vouch for the work.
    })
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.list().find((r) => r.runId === runId))
    await daemon.supervisor.idle()
    await waitFor(() => daemon.status().pendingUploads === 0)

    const run = daemon.supervisor.get(runId)
    expect(run.stopReason).toBe("submitted")
    expect(run.state).not.toBe("succeeded")
    expect(run.error).toMatch(/no verify command ran/)
    const report = server.runs.get(runId)?.completion?.report
    expect(report?.verify).toEqual({ status: "not_run" })
    expect(report?.publish?.pushed).not.toBe(true)
    expect(report?.publish?.commit).toBeUndefined()
    expect(spawnSync("git", ["rev-parse", "HEAD"], { cwd: run.worktree!, encoding: "utf8" }).stdout.trim()).toBe(initialHead)
    expect(report?.summary).toBe("All done, tests pass.")
    // The daemon's view of changed files, not the agent's empty list.
    expect(report?.filesChanged).toEqual(["CLAIMED.md"])
    expect(server.issueStatus.get("issue-self-verify")).toBe("in_progress")
    expect(server.issueOwner.get("issue-self-verify")?.reason).not.toBe(
      "review"
    )
    expect(server.unownedRuns()).toEqual([])
  })

  it("keeps a forged verify untrusted even when an approved push hands work in for a draft", async () => {
    const { repo, server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const policy = defaultRunPolicy()
    policy.permissions.git_push = "allow"
    const runId = server.queueRun(DEVICE, {
      issueId: "issue-self-verify-approved", repoId: "repo-1", baseBranch: "main",
      harness: "mock", prompt: "p", fixture: "self-verify", pushBranch: "mikka/mik-42", policy,
    })
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.list().find(run => run.runId === runId))
    await daemon.supervisor.idle()
    await waitFor(() => daemon.status().pendingUploads === 0)
    const run = daemon.supervisor.get(runId)
    const report = server.runs.get(runId)?.completion?.report
    expect(run.state).toBe("succeeded")
    expect(run.error).toMatch(/no verify command ran/)
    expect(report?.verify).toEqual({ status: "not_run" })
    expect(report?.summary).toBe("All done, tests pass.")
    expect(report?.publish).toMatchObject({ pushed: true, remote: "origin", branch: "mikka/mik-42" })
    const pushed = spawnSync("git", ["rev-parse", "mikka/mik-42"], { cwd: repo, encoding: "utf8" })
    expect(pushed.status).toBe(0)
    expect(pushed.stdout.trim()).toBe(report?.publish?.commit)
    expect(spawnSync("git", ["show", "mikka/mik-42:CLAIMED.md"], { cwd: repo, encoding: "utf8" }).status).toBe(0)
  })
})

describe("stopping never waits on an adapter", () => {
  it("stops while a run waits for an event that never comes, and resumes later", async () => {
    const { server, dataDir } = await setup()
    // `stall` hangs until the session is cancelled; stop() must not cancel it.
    const daemon = await boot(server, dataDir)
    const runId = server.queueRun(DEVICE, {
      issueId: "issue-stall",
      repoId: "repo-1",
      baseBranch: "main",
      harness: "mock",
      prompt: "p",
      fixture: "stall",
    })
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.get(runId).state === "running")

    const started = Date.now()
    await daemon.stop()
    daemons.splice(daemons.indexOf(daemon), 1)
    expect(Date.now() - started).toBeLessThan(5_000)
    // The run is not ended: it stays journaled for the next start.
    expect(daemon.supervisor.get(runId).state).toBe("running")

    // The lock was released: a new daemon starts at once and resumes it.
    const second = await boot(server, dataDir)
    await waitFor(() => second.supervisor.activeRunIds().includes(runId))
  })
})

describe("claimed runs without an adapter", () => {
  it("cleans up when stopped while its sandbox probe is running", async () => {
    const supported = vi.spyOn(SandboxRuntime, "supported").mockReturnValue(true)
    let finishProbe!: () => void
    const probe = vi.spyOn(SandboxRuntime.prototype, "probe").mockImplementation(
      () => new Promise<void>((resolve) => { finishProbe = resolve })
    )
    const reset = vi.spyOn(SandboxRuntime.prototype, "reset").mockResolvedValue()
    const listen = vi.spyOn(RpcServer.prototype, "listen")
    try {
      const { server, dataDir } = await setup()
      const daemon = new Daemon({ dataDir, flavor: "dev", link: server.link(), quotaSource: null })
      const started = daemon.start()
      await waitFor(() => probe.mock.calls.length > 0)
      const stopped = daemon.stop()
      finishProbe()
      await expect(started).rejects.toThrow("daemon stopped during startup")
      await stopped
      expect(reset).toHaveBeenCalledOnce()
      expect(listen).not.toHaveBeenCalled()
    } finally {
      supported.mockRestore()
      probe.mockRestore()
      reset.mockRestore()
      listen.mockRestore()
    }
  })

  it("releases its sandbox on stop and leaves injected sandboxes alone", async () => {
    const supported = vi.spyOn(SandboxRuntime, "supported").mockReturnValue(true)
    const probe = vi.spyOn(SandboxRuntime.prototype, "probe").mockResolvedValue()
    const reset = vi.spyOn(SandboxRuntime.prototype, "reset").mockResolvedValue()
    try {
      const { server, dataDir } = await setup()
      const daemon = await boot(server, dataDir)
      await daemon.stop()
      expect(reset).toHaveBeenCalledOnce()
      const injected = new SandboxRuntime()
      const next = await boot(server, tempDir(), { agentSandbox: injected })
      await next.stop()
      expect(reset).toHaveBeenCalledOnce()
    } finally {
      supported.mockRestore()
      probe.mockRestore()
      reset.mockRestore()
    }
  })

  it("releases its sandbox if startup fails after the probe", async () => {
    const supported = vi.spyOn(SandboxRuntime, "supported").mockReturnValue(true)
    const probe = vi.spyOn(SandboxRuntime.prototype, "probe").mockResolvedValue()
    const reset = vi.spyOn(SandboxRuntime.prototype, "reset").mockResolvedValue()
    const listen = vi.spyOn(RpcServer.prototype, "listen").mockRejectedValue(new Error("listen failed"))
    try {
      const { server, dataDir } = await setup()
      await expect(boot(server, dataDir)).rejects.toThrow("listen failed")
      expect(reset).toHaveBeenCalledOnce()
    } finally {
      supported.mockRestore()
      probe.mockRestore()
      reset.mockRestore()
      listen.mockRestore()
    }
  })

  it("keeps a detected CLI unschedulable and says why when sandbox startup fails", async () => {
    const supported = vi.spyOn(SandboxRuntime, "supported").mockReturnValue(true)
    const probe = vi.spyOn(SandboxRuntime.prototype, "probe").mockRejectedValue(new Error("bwrap: uid map failed"))
    const reset = vi.spyOn(SandboxRuntime.prototype, "reset").mockResolvedValue()
    try {
      const { server, dataDir } = await setup()
      const daemon = await boot(server, dataDir, {
        harnesses: [
          { harness: "mock", installed: true, version: "test" },
          { harness: "codex", installed: true, version: "1.0.0" },
        ],
      })
      expect(daemon.status().harnesses.filter((h) => h.installed).map((h) => h.harness)).toEqual(["mock"])
      const reported = server.devices.get(DEVICE)?.info.harnesses
      expect(reported?.filter((h) => h.installed).map((h) => h.harness)).toEqual(["mock"])
      expect(reported?.find((h) => h.harness === "codex")).toEqual({ harness: "codex", installed: false, version: "1.0.0", sandboxBlocked: { missing: [] } })
      expect(reset).toHaveBeenCalledOnce()
    } finally {
      supported.mockRestore()
      probe.mockRestore()
      reset.mockRestore()
    }
  })

  it("advertises only wired harnesses and fails an unsupported run with a completion", async () => {
    const { server, dataDir } = await setup()
    const detected: HarnessInfo[] = [
      { harness: "mock", installed: true, version: "test" },
      { harness: "codex", installed: true, version: "1.0.0" },
    ]
    // No agent sandbox: real CLIs are never driven unsandboxed.
    const daemon = await boot(server, dataDir, {
      harnesses: detected,
      agentSandbox: null,
    })
    expect(daemon.status().harnesses.map((h) => h.harness)).toEqual(["mock"])
    expect(
      server.devices.get(DEVICE)?.info.harnesses.map((h) => h.harness)
    ).toEqual(["mock"])

    const runId = server.queueRun(DEVICE, {
      issueId: "issue-codex",
      repoId: "repo-1",
      baseBranch: "main",
      harness: "codex",
      prompt: "p",
    })
    await daemon.syncWithServer()
    await waitFor(() => server.runs.get(runId)?.completion)
    expect(server.runs.get(runId)?.state).toBe("failed")
    expect(server.runs.get(runId)?.completion).toMatchObject({
      stopReason: "error",
      report: { summary: expect.stringMatching(/no adapter/) },
    })
    expect(server.unownedRuns()).toEqual([])
    expect(existsSync(join(dataDir, "worktrees", runId))).toBe(false)
  })
})

describe("data dir lock", () => {
  it("stops the daemon and reports it when the lock is compromised", async () => {
    const { server, dataDir } = await setup()
    let lost: Error | null = null
    const daemon = await boot(server, dataDir, {
      onLockLost: (error) => {
        lost = error
      },
    })
    daemon["onLockCompromised"](new Error("lock taken over"))
    await waitFor(() => lost)
    expect(lost).toMatchObject({ message: "lock taken over" })
    expect(daemon["stopped"]).toBe(true)
    daemons.splice(daemons.indexOf(daemon), 1)
  })

  it("takes over at once from a crashed holder, refuses a live one", async () => {
    const dataDir = tempDir()
    const paths = daemonPaths(dataDir)
    // A lock left by a holder whose process is gone.
    const dead = spawnSync(process.execPath, ["-e", "0"])
    mkdirSync(paths.lock)
    writeFileSync(join(dataDir, "daemon.pid"), `${dead.pid}\n`)
    const started = Date.now()
    const release = await acquireLock(dataDir, paths.lock, undefined, {
      socketPath: paths.socket,
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(readFileSync(join(dataDir, "daemon.pid"), "utf8").trim()).toBe(
      String(process.pid)
    )
    await expect(
      acquireLock(dataDir, paths.lock, undefined, { takeoverMs: 300 })
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError)
    await release()
    expect(existsSync(paths.lock)).toBe(false)
  })

  it("measures worktree disk usage asynchronously and caches it", async () => {
    const root = tempDir()
    const worktrees = new WorktreeManager(root)
    writeFileSync(join(root, "a"), "12345")
    expect(await worktrees.diskUsage()).toBe(5)
    writeFileSync(join(root, "b"), "123")
    // Within the TTL the cached figure is reused (no walk per heartbeat).
    expect(await worktrees.diskUsage()).toBe(5)
    expect(worktrees.cachedDiskUsage()).toBe(5)
    expect(await worktrees.diskUsage(0)).toBe(8)
  })
})

describe("setup recipe copies", () => {
  it("refuses symlinks on either end", async () => {
    const repo = await makeRepo()
    const outside = tempDir()
    writeFileSync(join(outside, "secret"), "host secret")
    symlinkSync(join(outside, "secret"), join(repo, "link-in"))
    const worktrees = new WorktreeManager(tempDir())
    const worktree = await worktrees.create("run-1", repo, "main")
    const recipe = (file: string) => ({ copyFiles: [file], approved: true })

    // Source is a symlink out of the repo.
    await expect(
      worktrees.bootstrap(worktree, repo, recipe("link-in"))
    ).rejects.toThrow(/symlink/)
    // Destination dir in the worktree is a symlink out of it.
    mkdirSync(join(repo, "conf"))
    writeFileSync(join(repo, "conf", "x"), "x")
    symlinkSync(outside, join(worktree, "conf"))
    await expect(
      worktrees.bootstrap(worktree, repo, recipe("conf/x"))
    ).rejects.toThrow(/symlink/)
    expect(existsSync(join(outside, "x"))).toBe(false)
    // A plain file still copies.
    expect(
      await worktrees.bootstrap(worktree, repo, recipe(".env.local"))
    ).toBe("done")
  })
})

describe.skipIf(process.platform === "win32")("data dir permissions", () => {
  it("tightens an existing data dir to 0700 on start", async () => {
    const { server } = await setup()
    const dataDir = join(tempDir(), "loose")
    mkdirSync(dataDir, { mode: 0o755 })
    expect(statSync(dataDir).mode & 0o777).toBe(0o755)
    await boot(server, dataDir)
    expect(statSync(dataDir).mode & 0o777).toBe(0o700)
  })
})
