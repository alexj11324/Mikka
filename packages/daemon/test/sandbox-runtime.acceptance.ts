// Required Linux CI mode: real isolation startup, with no agent CLI or credentials.
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { connect } from "node:net"

import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import pino from "pino"
import { expect, it } from "vitest"

import { SandboxRuntime } from "../src/agents/sandbox"
import { Daemon } from "../src/main"
import { MemoryServer } from "../src/server-link"
import { HttpServerLink } from "../src/server-link-http"
import { cleanupTempDirs, tempDir } from "./helpers"

const HOST_DENIAL = /(?:^sandbox probe failed: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted$|namespace.*(?:Operation not permitted|Permission denied)|(?:uid|gid) map.*(?:Operation not permitted|Permission denied|Read-only file system)|No permissions to create new namespace)/i

it("recognizes the observed loopback refusal while rejecting unknown probe errors", () => {
  expect(HOST_DENIAL.test("sandbox probe failed: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted")).toBe(true)
  expect(HOST_DENIAL.test("sandbox probe failed: bwrap: loopback: Failed RTM_NEWADDR: Invalid argument")).toBe(false)
  expect(HOST_DENIAL.test("sandbox probe failed: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted; unrelated error")).toBe(false)
  expect(HOST_DENIAL.test("sandbox probe failed: bwrap: execvp /bin/sh: No such file or directory")).toBe(false)
})

function runtimeResources() {
  return {
    port: SandboxManager.getProxyPort(),
    sockets: [SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath()],
  }
}

async function expectStopped(resources: ReturnType<typeof runtimeResources>) {
  expect(SandboxManager.getProxyPort()).toBeUndefined()
  expect(SandboxManager.getSocksProxyPort()).toBeUndefined()
  for (const socket of resources.sockets) {
    expect(socket).toBeDefined()
    expect(existsSync(socket!)).toBe(false)
  }
  const port = resources.port
  expect(port).toBeTypeOf("number")
  const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
    const socket = connect({ port: port!, host: "127.0.0.1" })
    socket.once("error", resolve)
    socket.once("connect", () => {
      socket.destroy()
      reject(new Error(`sandbox proxy still listening on ${port}`))
    })
    socket.setTimeout(2_000, () => {
      socket.destroy()
      reject(new Error(`sandbox proxy cleanup check timed out on ${port}`))
    })
  })
  expect(error.code).toBe("ECONNREFUSED")
}

it("probes real Linux isolation, advertises only usable harnesses, and cleans up on stop", async () => {
  expect(process.platform).toBe("linux")
  // Missing tools are a failure, never a skipped runtime acceptance.
  expect(SandboxManager.checkDependencies().errors).toEqual([])
  expect(SandboxRuntime.supported()).toBe(true)
  const runtime = new SandboxRuntime()
  let hostError: Error | undefined
  let daemon: Daemon | undefined
  try {
    try {
      await runtime.probe()
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      hostError = error as Error
      expect(hostError.message).toMatch(/^sandbox probe failed: bwrap:/)
      expect(hostError.message).toMatch(HOST_DENIAL)
    }
    const initial = runtimeResources()
    expect(initial.port).toBeTypeOf("number")
    await runtime.reset()
    await expectStopped(initial)

    const logs: { msg: string; err?: { message: string }; resources: ReturnType<typeof runtimeResources> }[] = []
    const log = pino({ level: "warn" }, {
      write: (line) => { logs.push({ ...JSON.parse(line), resources: runtimeResources() }) },
    })
    const device = "device-sandbox-acceptance"
    const server = new MemoryServer(device)
    const codexVersion = execFileSync(process.env.CODEX_CONTRACT_BIN!, ['--version'], {encoding:'utf8'}).trim()
    expect(codexVersion).toMatch(/\b0\.163\.0\b/)
    // Registration uses the production HTTP gate factory. The separate DB
    // roundtrip exercises this factory against actual approval handlers.
    const approvalLink = new HttpServerLink('http://127.0.0.1:1')
    const link = Object.assign(server.link(), {
      prepareRunToolApproval: approvalLink.prepareRunToolApproval.bind(approvalLink),
    })
    daemon = new Daemon({
      dataDir: tempDir(),
      flavor: "dev",
      link,
      credential: "synthetic-test-credential",
      harnesses: [
        { harness: "mock", installed: true, version: "test" },
        { harness: "codex", installed: true, version: codexVersion },
      ],
      harnessBinaries: {codex:process.env.CODEX_CONTRACT_BIN!},
      quotaSource: null,
      log,
    })
    await daemon.start()
    await daemon.syncWithServer()
    const advertised = hostError ? ["mock"] : ["mock", "codex"]
    expect(daemon.status().harnesses.map((info) => info.harness)).toEqual(advertised)
    expect(server.devices.get(device)?.info.harnesses.map((info) => info.harness)).toEqual(advertised)
    if (!hostError) {
      expect(daemon.status().harnesses.find(info=>info.harness==='codex')?.toolApproval).toBe(true)
      expect(server.devices.get(device)?.info.harnesses.find(info=>info.harness==='codex')?.toolApproval).toBe(true)
    }
    const unavailable = logs.filter((entry) => entry.msg === "agent sandbox unavailable")
    if (hostError) {
      expect(unavailable).toHaveLength(1)
      expect(unavailable[0]?.err?.message).toMatch(/^sandbox probe failed: bwrap:/)
      expect(unavailable[0]?.err?.message).toMatch(HOST_DENIAL)
      await expectStopped(unavailable[0]!.resources)
      console.log(`Sandbox acceptance: host denied isolation; daemon reported mock only: ${hostError.message}`)
    } else {
      expect(unavailable).toEqual([])
      const active = runtimeResources()
      expect(active.port).toBeTypeOf("number")
      await daemon.stop()
      await expectStopped(active)
      // A fresh owner must be able to start isolation after daemon.stop().
      await runtime.probe()
      const restarted = runtimeResources()
      expect(restarted.port).toBeTypeOf("number")
      await runtime.reset()
      await expectStopped(restarted)
      console.log("Sandbox acceptance: real probe, daemon stop, and restart passed")
    }
  } finally {
    await daemon?.stop()
    await runtime.reset()
    cleanupTempDirs()
  }
}, 60_000)

it("lets the agent commit on its run branch inside real isolation with the run's own policy", async () => {
  const { RepositoryCache } = await import("../src/repositories")
  const { WorktreeManager } = await import("../src/worktrees")
  const { worktreeGitWritePaths } = await import("../src/agents/publish")
  const { RunContext } = await import("../src/agents/run-context")
  const { makeRepo } = await import("./helpers")
  const { join } = await import("node:path")
  const { pathToFileURL } = await import("node:url")
  const { writeFileSync } = await import("node:fs")
  const { execa } = await import("execa")
  const source = await makeRepo()
  const root = tempDir()
  const cache = new RepositoryCache(join(root, "repos"))
  const path = await cache.prepare(pathToFileURL(source).href)
  const worktree = await new WorktreeManager(join(root, "worktrees")).create("commit-test", path, await cache.baseRef(pathToFileURL(source).href))
  const context = new RunContext({ harness: "claude_code", worktree, privateDir: root, runDir: join(root, "run"),
    gitWritePaths: await worktreeGitWritePaths(path, worktree, "commit-test") })
  writeFileSync(join(worktree, "agent.txt"), "agent change\n")
  // Git runs auto maintenance after a commit. Git 2.56 packs refs there by
  // default; older git does the same through `gc --auto` once there are too
  // many packs. Either rewrites the shared cache's packed-refs, which the run
  // may not write. Force that path on every git version.
  execFileSync("git", ["config", "gc.autoPackLimit", "1"], { cwd: path })
  execFileSync("git", ["config", "gc.autoDetach", "false"], { cwd: path })
  const loose = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: path, input: "loose\n", encoding: "utf8" })
  execFileSync("git", ["pack-objects", "-q", join(path, ".git", "objects", "pack", "pack")], { cwd: path, input: loose })
  expect(execFileSync("git", ["count-objects", "-v"], { cwd: path, encoding: "utf8" })).toMatch(/^packs: [2-9]/m)
  const sandbox = new SandboxRuntime()
  try {
    const wrapped = await sandbox.wrap(["/bin/sh", "-c",
      "git add agent.txt && git -c commit.gpgSign=false -c user.name=Agent -c user.email=agent@mikka.invalid commit -qm agent && git rev-parse HEAD"],
      { ...context.policy(), allowDomains: [] })
    const result = await execa("/bin/sh", ["-c", wrapped.command], { cwd: worktree, reject: false, env: { ...process.env, ...context.tempEnv() } })
    wrapped.release()
    expect(wrapped.annotate(result.stderr)).toBe("")
    expect(result.exitCode).toBe(0)
    const head = result.stdout.trim()
    expect(execFileSync("git", ["rev-parse", "refs/heads/mikka/run-commit-test"], { cwd: path, encoding: "utf8" }).trim()).toBe(head)
  } finally {
    await sandbox.reset()
    cleanupTempDirs()
  }
})
