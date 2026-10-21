// One `git worktree` per run under the daemon's data dir (R4, R11, R12).
// The allow-list check happens before anything here is called.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { execa } from "execa"
import { simpleGit } from "simple-git"

import { assertBranchName, worktreeGitDir } from "./agents/publish"
import { buildChildEnv } from "./env"
import { assertSafeId } from "./ids"
import type { SetupRecipe } from "./server-link"

/** How long a disk usage figure is reused before the tree is walked again. */
export const DISK_USAGE_TTL_MS = 5 * 60_000

/** How long fetching an issue branch may take before the run starts from base. */
export const FETCH_TIMEOUT_MS = 60_000

/** Git config for fetching into the main repo: no hooks, no `ext::`. */
const FETCH_GIT = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "protocol.ext.allow=never",
]

export function runBranch(runId: string) {
  return `orvilo/run-${assertSafeId("run id", runId)}`
}

/** `child` is `parent` or below it (both already resolved). */
export function isInside(parent: string, child: string) {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export class WorktreeManager {
  private usage = 0
  private usageAt = 0
  private usageRefresh: Promise<number> | null = null

  constructor(private readonly root: string) {}

  /** The run's worktree dir; never outside the worktree root. */
  pathFor(runId: string) {
    const root = resolve(this.root)
    const path = resolve(root, assertSafeId("run id", runId))
    if (dirname(path) !== root) {
      throw new Error(`worktree path escapes ${root}: ${runId}`)
    }
    return path
  }

  /**
   * Creates (or reuses, after a restart) the run's worktree from
   * `baseBranch` (a branch name or a commit id).
   */
  async create(
    runId: string,
    repoPath: string,
    baseBranch: string
  ): Promise<string> {
    const path = this.pathFor(runId)
    if (existsSync(join(path, ".git"))) return path
    mkdirSync(this.root, { recursive: true })
    await simpleGit(repoPath).raw([
      "worktree",
      "add",
      "-B",
      runBranch(runId),
      path,
      // The base branch comes from the server: never let it read as an option.
      "--end-of-options",
      baseBranch,
    ])
    return path
  }

  /**
   * The commit `branch` points at on `remote`, fetched into the repo, for a
   * fresh worktree of an issue that already has a branch (ADR 0024): the
   * run builds on it, so a person's commits there stay and the run's push
   * is a fast-forward. Throws when the fetch fails or the branch is not
   * there; the caller then starts from the base branch. The fetch goes
   * through a ref of the run's own (FETCH_HEAD is shared by concurrent
   * runs), dropped again once read.
   */
  async fetchBranch(
    repoPath: string,
    remote: string,
    branch: string,
    runId: string
  ): Promise<string> {
    await assertBranchName(branch)
    const ref = `refs/orvilo/fetch/${assertSafeId("run id", runId)}`
    const git = (args: string[], timeout?: number) =>
      execa("git", [...FETCH_GIT, ...args], {
        cwd: repoPath,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdin: "ignore",
        timeout,
      })
    try {
      await git(
        [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          "--end-of-options",
          remote,
          `+refs/heads/${branch}:${ref}`,
        ],
        FETCH_TIMEOUT_MS
      )
      return (await git(["rev-parse", "--verify", `${ref}^{commit}`])).stdout
        .toString()
        .trim()
    } finally {
      await git(["update-ref", "-d", ref]).catch(() => undefined)
    }
  }

  /**
   * A follow-up run works on in the worktree of the run it continues (a
   * chain of continuations shares the first run's worktree): the
   * worktree switches to this run's branch at the same commit, keeping
   * whatever the earlier run left uncommitted. Null when that worktree is
   * gone (pruned) or belongs to another repo; the caller then starts a
   * fresh one. Git runs pinned to the git dir `repoPath` lists for the
   * worktree, with hooks off: the agent wrote in that tree.
   */
  async continueFrom(
    repoPath: string,
    previousWorktree: string,
    runId: string
  ): Promise<string | null> {
    const root = resolve(this.root)
    const path = resolve(previousWorktree)
    if (dirname(path) !== root) return null
    if (!existsSync(join(path, ".git"))) return null
    let gitDir: string
    try {
      gitDir = await worktreeGitDir(repoPath, path)
    } catch {
      return null
    }
    const git = (args: string[]) =>
      execa("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: realpathSync(path),
        env: { GIT_DIR: gitDir, GIT_WORK_TREE: realpathSync(path) },
        stdin: "ignore",
      })
    const branch = `refs/heads/${runBranch(runId)}`
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim()
    await git(["update-ref", branch, head])
    await git(["symbolic-ref", "HEAD", branch])
    return path
  }

  /** Paths changed in the worktree (tracked and untracked), for the report. */
  async changedFiles(worktree: string): Promise<string[]> {
    const status = await simpleGit(worktree).status()
    return status.files.map((file) => file.path)
  }

  /**
   * Runs the repo's approved setup recipe in a fresh worktree: copy
   * git-ignored files from the main checkout, then the setup command with a
   * clean env. An unapproved recipe is skipped (it would need asking).
   */
  async bootstrap(
    worktree: string,
    repoPath: string,
    recipe: SetupRecipe | undefined
  ): Promise<"skipped" | "done"> {
    if (!recipe || !recipe.approved) return "skipped"
    const repoReal = realpathSync(repoPath)
    const worktreeReal = realpathSync(worktree)
    for (const file of recipe.copyFiles) {
      const rel = relative(repoPath, resolve(repoPath, file))
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`setup recipe copies a file outside the repo: ${file}`)
      }
      const from = join(repoPath, rel)
      const fromStat = lstatSync(from, { throwIfNoEntry: false })
      if (!fromStat) continue
      // Symlinks (the file itself or a parent dir) could pull in or overwrite
      // files outside the repo and the worktree; both ends must stay inside.
      if (!fromStat.isFile() || !isInside(repoReal, realpathSync(from))) {
        throw new Error(
          `setup recipe copies a symlink or non-file, or leaves the repo: ${file}`
        )
      }
      const to = join(worktree, rel)
      mkdirSync(dirname(to), { recursive: true })
      const toStat = lstatSync(to, { throwIfNoEntry: false })
      if (
        !isInside(worktreeReal, realpathSync(dirname(to))) ||
        (toStat && !toStat.isFile())
      ) {
        throw new Error(
          `setup recipe would write through a symlink or outside the worktree: ${file}`
        )
      }
      copyFileSync(from, to)
    }
    if (recipe.command) {
      await execa(recipe.command, {
        shell: true,
        cwd: worktree,
        env: buildChildEnv(),
        extendEnv: false,
        stdio: "ignore",
      })
    }
    return "done"
  }

  async remove(runId: string, repoPath: string) {
    await this.removePath(this.pathFor(runId), repoPath)
  }

  private async removePath(path: string, repoPath: string) {
    try {
      await simpleGit(repoPath).raw(["worktree", "remove", "--force", path])
    } catch {
      rmSync(path, { recursive: true, force: true })
      await simpleGit(repoPath)
        .raw(["worktree", "prune"])
        .catch(() => undefined)
    }
  }

  /**
   * Drops a worktree and the branches of the runs that worked in it (a
   * follow-up run shares the worktree of the run it continues) when they left
   * nothing behind: no new commit on any of the branches (commits already on
   * another branch or a remote do not count, nor do other runs' branches)
   * and nothing uncommitted. Anything else is kept for a person to look at.
   * Returns whether it was removed.
   */
  async discardIfEmpty(
    runIds: readonly string[],
    worktree: string | null,
    repoPath: string
  ): Promise<boolean> {
    const root = resolve(this.root)
    const path = worktree ? resolve(worktree) : null
    if (path && dirname(path) !== root) return false
    const git = simpleGit(repoPath)
    if (path && existsSync(join(path, ".git"))) {
      if ((await this.changedFiles(path)).length > 0) return false
    }
    const branches: string[] = []
    for (const runId of runIds) {
      const branch = runBranch(runId)
      // simple-git resolves a silent non-zero exit (`--quiet`), so the
      // answer is the printed sha, not whether the call threw.
      const exists = await git
        .raw(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
        .then((out) => out.trim().length > 0)
        .catch(() => false)
      if (!exists) continue
      const ahead = await git.raw([
        "rev-list",
        "--count",
        `refs/heads/${branch}`,
        "--not",
        "--exclude=orvilo/run-*",
        "--branches",
        "--remotes",
      ])
      if (Number(ahead.trim()) > 0) return false
      branches.push(branch)
    }
    if (path) await this.removePath(path, repoPath)
    for (const branch of branches)
      await git.raw(["branch", "-D", "--", branch]).catch(() => undefined)
    return true
  }

  /**
   * The repo's local `orvilo/run-*` branches with the worktree each is
   * checked out in (null: none). A branch checked out in the repo itself or
   * outside the daemon's worktree root is left out.
   */
  async runBranches(
    repoPath: string
  ): Promise<{ runId: string; worktree: string | null }[]> {
    const out = await simpleGit(repoPath).raw([
      "branch",
      "--list",
      "orvilo/run-*",
      "--format=%(refname:short)\t%(worktreepath)",
    ])
    const root = resolve(this.root)
    const repo = resolve(repoPath)
    const branches: { runId: string; worktree: string | null }[] = []
    for (const line of out.split("\n")) {
      const [name, where = ""] = line.split("\t")
      const runId = name?.startsWith("orvilo/run-")
        ? name.slice("orvilo/run-".length)
        : ""
      if (!runId) continue
      const worktree = where.trim() ? resolve(where.trim()) : null
      if (worktree && (worktree === repo || dirname(worktree) !== root))
        continue
      branches.push({ runId, worktree })
    }
    return branches
  }

  /** Run ids of worktrees on disk. */
  list(): string[] {
    try {
      return readdirSync(this.root)
    } catch {
      return []
    }
  }

  /** Last measured bytes used by all run worktrees (R12); never blocks. */
  cachedDiskUsage(): number {
    return this.usage
  }

  /**
   * Bytes used by all run worktrees, re-measured (asynchronously) only when
   * the last figure is older than `maxAgeMs`; concurrent calls share a walk.
   */
  async diskUsage(maxAgeMs = DISK_USAGE_TTL_MS, now = Date.now()) {
    if (this.usageAt > 0 && now - this.usageAt < maxAgeMs) return this.usage
    this.usageRefresh ??= du(this.root)
      .then((bytes) => {
        this.usage = bytes
        this.usageAt = Date.now()
        return bytes
      })
      .finally(() => {
        this.usageRefresh = null
      })
    return this.usageRefresh
  }

  /**
   * Removes worktrees of finished runs older than `retentionMs`. Removal
   * after PR merge is the same call, triggered once the server reports it.
   */
  async prune(
    finished: { runId: string; repoPath: string; finishedAt: string }[],
    retentionMs: number,
    now = Date.now()
  ): Promise<string[]> {
    const removed: string[] = []
    for (const run of finished) {
      if (now - Date.parse(run.finishedAt) < retentionMs) continue
      if (!existsSync(this.pathFor(run.runId))) continue
      await this.remove(run.runId, run.repoPath)
      removed.push(run.runId)
    }
    return removed
  }
}

async function du(path: string): Promise<number> {
  let stat
  try {
    stat = await lstat(path)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.size
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) total += await du(join(path, entry))
  return total
}
