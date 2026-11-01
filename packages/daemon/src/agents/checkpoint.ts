// Checkpoints (work in progress saved outside the machine): after tool calls
// and on a timer, the daemon diffs the whole worktree against the commit it
// started from and hands the patch to the server. When this machine goes
// offline, the server gives the run to another one, which starts at the same
// commit and applies the patch. The agent never takes part: models differ in
// whether they commit or push on their own, so nothing here relies on it.
//
// Git runs pinned to the git dir the main repo lists for the worktree, with
// hooks off, the same way publishing does (./publish).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"

import { execa } from "execa"

import { RUN_CHECKPOINT_MAX_BYTES, RUN_CHECKPOINT_RECOVERY_MAX_AGE_MS, type RunCheckpoint } from "@mikka/protocol"

import { pinnedGit, snapshotTree } from "./publish"

export class CheckpointRecoveryError extends Error {
  constructor(message: string) { super(message); this.name = 'CheckpointRecoveryError' }
}

export function assertCheckpointFresh(checkpoint: RunCheckpoint, now = Date.now()) {
  if (checkpoint.unavailableReason)
    throw new CheckpointRecoveryError('Checkpoint exceeds the recovery size limit. Restore the original worktree before retrying.')
  const time = Date.parse(checkpoint.takenAt)
  if (!Number.isFinite(time) || now - time > RUN_CHECKPOINT_RECOVERY_MAX_AGE_MS)
    throw new CheckpointRecoveryError('Checkpoint is older than the thirty-minute recovery window.')
}

/** The worktree's commit right now; a run records it as its base once. */
export async function headCommit(
  repoPath: string,
  worktree: string
): Promise<string> {
  const git = await pinnedGit(repoPath, worktree)
  return String((await git(["rev-parse", "HEAD"])).stdout).trim()
}

export interface TakenCheckpoint {
  /** The worktree's content as a tree; equal trees mean nothing changed. */
  tree: string
  /** Clean trees and unavailable trees both supersede the previous snapshot. */
  checkpoint: RunCheckpoint
}

/**
 * The worktree against `baseCommit`. `lastTree` is the tree of the previous
 * checkpoint: when nothing changed since, there is nothing to send.
 */
export async function takeCheckpoint(options: {
  repoPath: string
  worktree: string
  baseCommit: string
  lastTree?: string
}): Promise<TakenCheckpoint | null> {
  const tree = await snapshotTree(options.repoPath, options.worktree)
  if (tree === options.lastTree) return null
  const git = await pinnedGit(options.repoPath, options.worktree)
  const names = String(
    (await git(["diff", "--name-only", options.baseCommit, tree])).stdout
  )
    .split("\n")
    .filter(Boolean)
  // Bytes, not text: binary patches must survive unchanged.
  const diff = (
    await git(
      ["diff", "--binary", "--no-color", options.baseCommit, tree],
      undefined,
      { buffer: true }
    )
  ).stdout as unknown as Uint8Array
  const gzipped = gzipSync(diff)
  const unavailable = gzipped.length > RUN_CHECKPOINT_MAX_BYTES
  return {
    tree,
    checkpoint: {
      baseCommit: options.baseCommit,
      patch: (unavailable ? gzipSync(Buffer.alloc(0)) : gzipped).toString("base64"),
      files: names.length,
      takenAt: new Date().toISOString(),
      ...(unavailable ? { unavailableReason: 'too_large' as const } : {}),
    },
  }
}

/**
 * Applies a checkpoint to a fresh worktree as uncommitted changes. False
 * when it does not apply. The caller must block recovery instead of starting
 * the agent without the work it was asked to continue.
 */
export async function applyCheckpoint(options: {
  repoPath: string
  worktree: string
  checkpoint: RunCheckpoint
}): Promise<boolean> {
  const git = await pinnedGit(options.repoPath, options.worktree)
  const dir = mkdtempSync(join(tmpdir(), "mikka-checkpoint-"))
  const file = join(dir, "checkpoint.patch")
  try {
    const patch = gunzipSync(Buffer.from(options.checkpoint.patch, "base64"))
    if (!patch.length && options.checkpoint.files === 0) return true
    writeFileSync(file, patch)
    for (const args of [
      ["apply", "--binary", "--whitespace=nowarn", file],
      ["apply", "--binary", "--3way", "--whitespace=nowarn", file],
    ]) {
      try {
        await git(args)
        return true
      } catch {
        // Try the next way; the last failure means it does not apply.
      }
    }
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Whether `commit` is in the main repo, so a worktree can start there. */
export async function hasCommit(
  repoPath: string,
  commit: string
): Promise<boolean> {
  return execa(
    "git",
    ["-c", "core.hooksPath=/dev/null", "cat-file", "-e", `${commit}^{commit}`],
    { cwd: repoPath, stdin: "ignore" }
  ).then(
    () => true,
    () => false
  )
}
