import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { WorktreeManager, runBranch } from "../src/worktrees"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterEach(() => cleanupTempDirs())

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

describe("starting on the issue branch", () => {
  /** A repo with an `origin` that has `main` and a person's commit on `mikka/orv-1`. */
  async function repoWithIssueBranch() {
    const repo = await makeRepo()
    const origin = tempDir("orvo-")
    git(origin, "init", "-q", "--bare")
    git(repo, "remote", "add", "origin", origin)
    git(repo, "push", "-q", "origin", "main")
    const person = join(tempDir("orvp-"), "clone")
    git(origin, "clone", "-q", origin, person)
    git(person, "checkout", "-q", "-b", "mikka/orv-1")
    writeFileSync(join(person, "PERSON.md"), "by hand\n")
    git(person, "add", "PERSON.md")
    git(
      person,
      "-c",
      "user.name=Person",
      "-c",
      "user.email=person@mikka.invalid",
      "commit",
      "-q",
      "-m",
      "person"
    )
    git(person, "push", "-q", "origin", "mikka/orv-1")
    return { repo, origin, tip: git(person, "rev-parse", "HEAD") }
  }

  it("builds a fresh worktree on the remote branch, with a person's commits", async () => {
    const { repo, tip } = await repoWithIssueBranch()
    const trees = new WorktreeManager(tempDir())
    const start = await trees.fetchBranch(repo, "origin", "mikka/orv-1", "r1")
    expect(start).toBe(tip)
    const path = await trees.create("r1", repo, start)
    expect(readFileSync(join(path, "PERSON.md"), "utf8")).toBe("by hand\n")
    expect(git(path, "rev-parse", "HEAD")).toBe(tip)
    expect(git(path, "symbolic-ref", "--short", "HEAD")).toBe(runBranch("r1"))
    // The fetch leaves no refs of its own behind.
    expect(git(repo, "for-each-ref", "refs/mikka")).toBe("")
  })

  it("throws when the branch or the remote is missing", async () => {
    const { repo } = await repoWithIssueBranch()
    const trees = new WorktreeManager(tempDir())
    await expect(
      trees.fetchBranch(repo, "origin", "mikka/orv-2", "r1")
    ).rejects.toThrow()
    await expect(
      trees.fetchBranch(repo, "nowhere", "mikka/orv-1", "r1")
    ).rejects.toThrow()
    await expect(
      trees.fetchBranch(repo, "origin", "--upload-pack=x", "r1")
    ).rejects.toThrow(/branch name/)
    expect(git(repo, "for-each-ref", "refs/mikka")).toBe("")
  })
})

describe("continuing a run's worktree", () => {
  it("keeps the earlier run's uncommitted work on the new run's branch", async () => {
    const repo = await makeRepo()
    const trees = new WorktreeManager(tempDir())
    const first = await trees.create("run-1", repo, "main")
    writeFileSync(join(first, "draft.md"), "half done\n")

    const path = await trees.continueFrom(repo, first, "run-2")
    // A third run continues the same tree.
    expect(await trees.continueFrom(repo, first, "run-3")).toBe(first)
    expect(path).toBe(first)
    expect(readFileSync(join(first, "draft.md"), "utf8")).toBe("half done\n")
    expect(git(first, "symbolic-ref", "--short", "HEAD")).toBe(
      runBranch("run-3")
    )
    expect(git(first, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"))
  })

  it("starts fresh when the earlier worktree is gone", async () => {
    const repo = await makeRepo()
    const trees = new WorktreeManager(tempDir())
    expect(
      await trees.continueFrom(repo, trees.pathFor("run-1"), "run-2")
    ).toBeNull()
    expect(await trees.continueFrom(repo, repo, "run-2")).toBeNull()
  })

  it("does not continue a worktree of another repo", async () => {
    const repo = await makeRepo()
    const other = await makeRepo()
    const trees = new WorktreeManager(tempDir())
    const first = await trees.create("run-1", other, "main")
    expect(await trees.continueFrom(repo, first, "run-2")).toBeNull()
    expect(existsSync(first)).toBe(true)
  })
})

describe("discarding an empty run", () => {
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), "x\n")
    git(cwd, "add", file)
    git(
      cwd,
      "-c",
      "user.name=Agent",
      "-c",
      "user.email=agent@mikka.invalid",
      "commit",
      "-q",
      "-m",
      file
    )
  }

  it("removes the worktree and branch when the run changed nothing", async () => {
    const repo = await makeRepo()
    const trees = new WorktreeManager(tempDir())
    const path = await trees.create("r1", repo, "main")
    expect(await trees.discardIfEmpty(["r1"], path, repo)).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(git(repo, "branch", "--list", runBranch("r1"))).toBe("")
  })

  it("keeps a run with a new commit or uncommitted changes", async () => {
    const repo = await makeRepo()
    const trees = new WorktreeManager(tempDir())
    const committed = await trees.create("r1", repo, "main")
    commit(committed, "a.txt")
    expect(await trees.discardIfEmpty(["r1"], committed, repo)).toBe(false)
    expect(existsSync(committed)).toBe(true)
    const dirty = await trees.create("r2", repo, "main")
    writeFileSync(join(dirty, "b.txt"), "wip\n")
    expect(await trees.discardIfEmpty(["r2"], dirty, repo)).toBe(false)
    expect(git(repo, "branch", "--list", runBranch("r2"))).not.toBe("")
  })

  it("removes a worktree shared by a follow-up run together with both branches", async () => {
    const repo = await makeRepo()
    const trees = new WorktreeManager(tempDir())
    const path = await trees.create("r1", repo, "main")
    expect(await trees.continueFrom(repo, path, "r2")).toBe(path)
    expect(await trees.discardIfEmpty(["r1", "r2"], path, repo)).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(git(repo, "branch", "--list", "mikka/run-*")).toBe("")
  })

  it("keeps a shared worktree when the follow-up run committed", async () => {
    const repo = await makeRepo()
    const trees = new WorktreeManager(tempDir())
    const path = await trees.create("r1", repo, "main")
    await trees.continueFrom(repo, path, "r2")
    commit(path, "c.txt")
    expect(await trees.discardIfEmpty(["r1", "r2"], path, repo)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  it("skips a run whose branch is already gone instead of failing", async () => {
    const repo = await makeRepo()
    const trees = new WorktreeManager(tempDir())
    // Already cleaned up, then asked again (every start sweeps the journal).
    expect(await trees.discardIfEmpty(["gone"], null, repo)).toBe(true)
    const path = await trees.create("r1", repo, "main")
    expect(await trees.discardIfEmpty(["gone", "r1"], path, repo)).toBe(true)
    expect(existsSync(path)).toBe(false)
    const kept = await trees.create("r2", repo, "main")
    commit(kept, "d.txt")
    expect(await trees.discardIfEmpty(["gone", "r2"], kept, repo)).toBe(false)
    expect(existsSync(kept)).toBe(true)
  })
})
