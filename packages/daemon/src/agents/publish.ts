// After a run is handed in and verified, the daemon (outside the sandbox)
// commits exactly the tree that was verified on the run's branch and, when
// the repo allows it, pushes the commit to the issue's branch, which the
// issue's pull request follows (ADR 0009: `git push` is the daemon's job,
// never the agent's; ADR 0024: one branch and one pull request per issue).
//
// The sandbox keeps indirection/config files read-only while allowing the
// run's own git index and objects. Every daemon git call here is pinned to
// the git dir the main repo lists for this worktree (never what a `.git`
// file in the tree says), and hooks, fsmonitor, signing and `ext::`
// transports are off.
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { assertSafeId } from "../ids"

import type { RunPublish } from "@mikka/protocol"
import { execa } from "execa"

import { runBranch } from "../worktrees"

export interface PublishOptions {
  runId: string
  /** The daemon-owned clone cache (or private hosted workspace). */
  repoPath: string
  worktree: string
  /** The verified tree (`snapshotTree`); what gets committed. */
  tree: string
  /** Commit message body: the agent's summary. */
  summary: string
  issueId: string
  /**
   * The issue's branch (ADR 0024): the commit is pushed there instead of
   * the run's own branch. The local commit stays on the run's branch.
   */
  pushBranch?: string
  /** The branch the run started from; tells an issue commit from base. */
  baseBranch?: string
  /**
   * Push only when allowed: the repo approved it ("always for this repo")
   * or the workspace allows pushes (`pushDecision` in ../permissions).
   * `note` says why not otherwise.
   */
  push: { approved: boolean; remote: string; note?: string }
  /** The daemon's own env (git credentials, SSH agent). */
  env?: NodeJS.ProcessEnv
}

/** Git config that keeps agent-written files from running code here. */
const SAFE_GIT = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "protocol.ext.allow=never",
]

const FALLBACK_IDENTITY = [
  "-c",
  "user.name=Mikka Agent",
  "-c",
  "user.email=agent@mikka.invalid",
]

/**
 * The worktree's git dir as the main repo records it: the entry under
 * `<common dir>/worktrees` whose `gitdir` points back at this worktree.
 */
export async function worktreeGitDir(
  repoPath: string,
  worktree: string
): Promise<string> {
  const common = realpathSync(
    (
      await execa(
        "git",
        [
          ...SAFE_GIT,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        {
          cwd: repoPath,
          stdin: "ignore",
        }
      )
    ).stdout.trim()
  )
  const dotGit = join(realpathSync(worktree), ".git")
  const root = join(common, "worktrees")
  for (const name of readdirSync(root)) {
    const gitdirFile = join(root, name, "gitdir")
    let target: string
    try {
      target = readFileSync(gitdirFile, "utf8").trim()
    } catch {
      continue
    }
    if (target === dotGit || safeRealpath(target) === dotGit) {
      return join(root, name)
    }
  }
  throw new Error(`${worktree} is not a worktree of ${repoPath}`)
}

/** Only this run's git administration and shared immutable object storage. */
export async function worktreeGitWritePaths(repoPath: string, worktree: string, runId: string): Promise<string[]> {
  const gitDir = await worktreeGitDir(repoPath, worktree)
  const common = resolve(gitDir, '..', '..')
  const branch = `mikka/run-${assertSafeId('run id', runId)}`
  const ref = join(common, 'refs', 'heads', branch)
  const logsRef = join(common, 'logs', 'refs', 'heads', branch)
  // Git creates `<branch>.lock` beside the ref (and appends the reflog) when it
  // updates the branch, so the ref's directory must be writable in the sandbox,
  // not just the ref file — binding only the leaf leaves the containing
  // `refs/heads/mikka/` read-only and `git commit` fails with EROFS.
  return [gitDir, join(common, 'objects'), dirname(ref), ref, `${ref}.lock`, dirname(logsRef), logsRef]
}

function safeRealpath(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export type Git = (
  args: string[],
  env?: Record<string, string>,
  options?: { buffer?: boolean }
) => ReturnType<typeof execa>

export async function pinnedGit(
  repoPath: string,
  worktree: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Git> {
  const gitDir = await worktreeGitDir(repoPath, worktree)
  const workTree = realpathSync(worktree)
  return (args, extra, options) =>
    execa("git", [...SAFE_GIT, ...args], {
      cwd: workTree,
      env: { ...env, ...extra, GIT_DIR: gitDir, GIT_COMMON_DIR: resolve(gitDir, "..", ".."), GIT_WORK_TREE: workTree },
      extendEnv: false,
      stdin: "ignore",
      ...(options?.buffer
        ? { encoding: "buffer" as const, stripFinalNewline: false }
        : {}),
    })
}

/**
 * The worktree's content as a git tree (what `git add --all` would stage),
 * built in a throwaway index so the worktree's own index is untouched.
 * Comparing two snapshots tells whether anything changed in between.
 */
export async function snapshotTree(
  repoPath: string,
  worktree: string,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const git = await pinnedGit(repoPath, worktree, env)
  const dir = mkdtempSync(join(tmpdir(), "mikka-index-"))
  const index = { GIT_INDEX_FILE: join(dir, "index") }
  try {
    await git(["read-tree", "HEAD"], index)
    await git(["add", "--all"], index)
    return String((await git(["write-tree"], index)).stdout).trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function commitMessage(options: {
  runId: string
  issueId: string
  summary: string
}): string {
  const lines = options.summary.trim().split("\n")
  const title = (lines[0] || "Agent changes").slice(0, 72)
  const body = lines.slice(1).join("\n").trim()
  return [
    `mikka: ${title}`,
    ...(body ? ["", body] : []),
    "",
    `Mikka-Run: ${options.runId}`,
    `Mikka-Issue: ${options.issueId}`,
  ].join("\n")
}

/**
 * Commits the verified tree on the run's branch and pushes it to the
 * issue's branch (or the run's own without one). Every outcome is a
 * `RunPublish`: `skipped` says why nothing was pushed on purpose; a failed
 * commit or push has `pushed: false`, no `skipped`, and a `note`.
 */
export async function publishRun(options: PublishOptions): Promise<RunPublish> {
  const runBranchName = runBranch(options.runId)
  const target = options.pushBranch ?? runBranchName
  const remote = options.push.remote
  const git = await pinnedGit(options.repoPath, options.worktree, options.env)
  const head = String((await git(["rev-parse", "HEAD"])).stdout).trim()
  const headTree = String(
    (await git(["rev-parse", "HEAD^{tree}"])).stdout
  ).trim()

  // Never forced: the issue branch only moves forward, so a person's
  // commits pushed there in the meantime make this fail instead of vanish.
  const push = async (
    commit: string,
    skipped?: "no_changes"
  ): Promise<RunPublish> => {
    try {
      await assertBranchName(target)
      await git([
        "push",
        "--no-verify",
        "--porcelain",
        "--end-of-options",
        remote,
        `${commit}:refs/heads/${target}`,
      ])
      return {
        branch: target,
        commit,
        pushed: true,
        remote,
        ...(skipped ? { skipped } : {}),
      }
    } catch (error) {
      return {
        branch: target,
        commit,
        pushed: false,
        remote,
        note: `Push failed: ${gitError(error)}`,
      }
    }
  }

  if (options.tree === headTree) {
    // Nothing new to commit, but HEAD may already be this issue's work (an
    // earlier run's commit in a continued worktree, or the issue branch a
    // fresh worktree was built on). Pushing it again is a no-op or a
    // fast-forward, and tells the orchestrator which commit CI checks.
    if (
      options.push.approved &&
      options.pushBranch &&
      !(await onBase(git, head, options.baseBranch))
    ) {
      return push(head, "no_changes")
    }
    return {
      branch: runBranchName,
      commit: null,
      pushed: false,
      remote: null,
      skipped: "no_changes",
      note: "No changes to commit",
    }
  }

  let commit: string
  try {
    const identity = await git(["config", "user.email"]).then(
      (result) => (String(result.stdout).trim() ? [] : FALLBACK_IDENTITY),
      () => FALLBACK_IDENTITY
    )
    commit = String(
      (
        await git([
          ...identity,
          "commit-tree",
          options.tree,
          "-p",
          head,
          "-m",
          commitMessage(options),
        ])
      ).stdout
    ).trim()
    // The worktree's branch (and HEAD) move to the commit; its index follows.
    await git(["update-ref", `refs/heads/${runBranchName}`, commit, head])
    await git(["read-tree", commit])
  } catch (error) {
    return {
      branch: runBranchName,
      commit: null,
      pushed: false,
      remote: null,
      note: `Commit failed: ${gitError(error)}`,
    }
  }
  if (!options.push.approved) {
    return {
      branch: runBranchName,
      commit,
      pushed: false,
      remote: null,
      skipped: "not_approved",
      note: options.push.note ?? "Push needs approval for this repo",
    }
  }
  return push(commit)
}

/**
 * HEAD is the base branch's tip or behind it: the worktree holds no commit
 * of the issue's own. A base that does not resolve counts as on base, so
 * nothing is pushed.
 */
async function onBase(git: Git, head: string, baseBranch?: string) {
  if (!baseBranch) return true
  const base = await git([
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${baseBranch}^{commit}`,
  ]).then(
    (result) => String(result.stdout).trim(),
    () => ""
  )
  if (!base) return true
  return git(["merge-base", "--is-ancestor", head, base]).then(
    () => true,
    () => false
  )
}

/** Branch names come from the server: only a plain branch name passes. */
export async function assertBranchName(branch: string) {
  const { exitCode } = await execa(
    "git",
    ["check-ref-format", `refs/heads/${branch}`],
    { reject: false, stdin: "ignore" }
  )
  if (exitCode !== 0 || branch.startsWith("-")) {
    throw new Error(`Not a valid branch name: ${branch}`)
  }
}

function gitError(error: unknown) {
  const stderr =
    (error as { stderr?: string }).stderr || (error as Error).message
  return String(stderr).trim().slice(-500)
}
