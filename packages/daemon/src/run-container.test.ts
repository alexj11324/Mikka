import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { containerArgs, containerMounts, runnerImageTag, selectIsolation } from "./run-container"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "run-container-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("selectIsolation", () => {
  it("uses containers on Linux with a Docker engine, and the per-run worktree mode otherwise", () => {
    expect(selectIsolation("linux", true)).toBe("container")
    expect(selectIsolation("linux", false)).toBe("worktree")
    expect(selectIsolation("darwin", true)).toBe("worktree")
    expect(selectIsolation("darwin", false)).toBe("worktree")
  })
})

describe("containerArgs", () => {
  const args = containerArgs({
    image: "mikka-runner:abc", runId: "run-1", owner: "owner", name: "mikka-run-run-1-1", cwd: "/work/tree",
    command: "claude", args: ["--print"], env: { ANTHROPIC_API_KEY: "secret-value", HOME: "/runs/run-1/native-home", PATH: "/host/bin", UNSET: undefined },
    mounts: ["-v", "/work/tree:/work/tree:rw"], egressSocket: "/tmp/egress.sock", uid: 501, gid: 20,
  })

  it("is disposable, unprivileged and has no network interface", () => {
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "-i"])
    for (const flag of [["--network", "none"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges"], ["--user", "501:20"]]) {
      expect(args.join(" ")).toContain(flag.join(" "))
    }
    expect(args).toContain("--read-only")
    expect(args).toContain("--pull=never")
  })

  it("passes credentials by name only, never their values", () => {
    expect(args.join(" ")).not.toContain("secret-value")
    expect(args.join(" ")).toContain("-e ANTHROPIC_API_KEY")
    expect(args).not.toContain("PATH")
    expect(args).not.toContain("UNSET")
  })

  it("runs the image's own CLI behind the egress relay", () => {
    expect(args.slice(-5)).toEqual(["mikka-runner:abc", "node", "/mikka/run-container-entry.mjs", "claude", "--print"])
    expect(args.join(" ")).toContain("/tmp/egress.sock:/run/mikka-egress.sock")
  })
})

describe("containerMounts", () => {
  it("mounts only what the run may write, read-only over what it must not change", () => {
    const worktree = join(dir, "tree"), runDir = join(dir, "run"), gitFile = join(dir, "tree.git")
    writeFileSync(gitFile, "gitdir: x")
    const mounts = containerMounts({ allowWrite: [worktree, runDir], denyWrite: [gitFile, join(dir, "missing")], denyRead: [], allowDomains: [] }, join(dir, "repo.git"))
    const pairs = mounts.filter((_, index) => index % 2 === 1)
    expect(pairs).toContain(`${worktree}:${worktree}:rw`)
    expect(pairs).toContain(`${runDir}:${runDir}:rw`)
    expect(pairs).toContain(`${gitFile}:${gitFile}:ro`)
    expect(pairs).toContain(`${join(dir, "repo.git")}:${join(dir, "repo.git")}:ro`)
    expect(pairs.some(pair => pair.includes("missing"))).toBe(false)
    expect(pairs.some(pair => pair.startsWith(`${process.env.HOME}:`))).toBe(false)
    expect(pairs.filter(pair => pair.endsWith(":rw"))).toHaveLength(2)
  })

  it("keeps a read-only run's worktree read-only", () => {
    const worktree = join(dir, "tree")
    writeFileSync(worktree, "")
    const pairs = containerMounts({ allowWrite: [worktree], denyWrite: [worktree], denyRead: [], allowDomains: [] }, null)
    expect(pairs).toContain(`${worktree}:${worktree}:ro`)
    expect(pairs).not.toContain(`${worktree}:${worktree}:rw`)
  })
})

describe("runnerImageTag", () => {
  it("names the image by the hash of its sources", () => {
    expect(runnerImageTag()).toMatch(/^mikka-runner:[a-f0-9]{16}$/)
    expect(runnerImageTag()).toBe(runnerImageTag())
  })
})
