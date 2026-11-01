import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import { RUN_CHECKPOINT_MAX_BYTES } from '@mikka/protocol'
import { applyCheckpoint, assertCheckpointFresh, headCommit, takeCheckpoint } from '../src/agents/checkpoint'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
afterEach(cleanupTempDirs)
async function freshWorktree(repo: string, commit: string) {
  const path = tempDir()
  git(repo, 'worktree', 'add', '--detach', path, commit)
  return path
}

it('restores tracked, binary and untracked work through an actual git checkpoint', async () => {
  const repo = await makeRepo(), base = git(repo, 'rev-parse', 'HEAD')
  const worktree = await freshWorktree(repo, base), baseCommit = await headCommit(repo, worktree)
  writeFileSync(join(worktree, 'README.md'), 'changed tracked file\n')
  writeFileSync(join(worktree, 'new.txt'), 'untracked work\n')
  writeFileSync(join(worktree, 'blob.bin'), Buffer.from([0, 1, 255, 0, 128]))
  writeFileSync(join(worktree, '.env.local'), 'FIXTURE_ONLY=not-a-credential\n')
  const snapshot = await takeCheckpoint({ repoPath: repo, worktree, baseCommit })
  expect(snapshot?.checkpoint.files).toBe(3)
  const moved = await freshWorktree(repo, baseCommit)
  expect(await applyCheckpoint({ repoPath: repo, worktree: moved, checkpoint: snapshot!.checkpoint })).toBe(true)
  expect(readFileSync(join(moved, 'README.md'), 'utf8')).toBe('changed tracked file\n')
  expect(readFileSync(join(moved, 'new.txt'), 'utf8')).toBe('untracked work\n')
  expect([...readFileSync(join(moved, 'blob.bin'))]).toEqual([0, 1, 255, 0, 128])
  expect(existsSync(join(moved, '.env.local'))).toBe(false)
  expect(git(moved, 'status', '--porcelain')).not.toContain('.env.local')
})

it('returning to the clean tree uploads a real empty snapshot instead of retaining discarded changes', async () => {
  const repo = await makeRepo(), base = git(repo, 'rev-parse', 'HEAD')
  const worktree = await freshWorktree(repo, base), baseCommit = await headCommit(repo, worktree)
  writeFileSync(join(worktree, 'README.md'), 'discard this work\n')
  const changed = await takeCheckpoint({ repoPath: repo, worktree, baseCommit })
  git(worktree, 'checkout', '--', 'README.md')
  const clean = await takeCheckpoint({ repoPath: repo, worktree, baseCommit, lastTree: changed!.tree })
  expect(clean?.checkpoint.files).toBe(0)
  expect(gunzipSync(Buffer.from(clean!.checkpoint.patch, 'base64')).length).toBe(0)
  const moved = await freshWorktree(repo, baseCommit)
  expect(await applyCheckpoint({ repoPath: repo, worktree: moved, checkpoint: clean!.checkpoint })).toBe(true)
  expect(readFileSync(join(moved, 'README.md'), 'utf8')).toBe('# Sandbox\n')
  expect(await takeCheckpoint({ repoPath: repo, worktree, baseCommit, lastTree: clean!.tree })).toBe(null)
})

it('an actual patch over eight MiB produces a small explicit unavailable snapshot', async () => {
  const repo = await makeRepo(), base = git(repo, 'rev-parse', 'HEAD')
  const worktree = await freshWorktree(repo, base), baseCommit = await headCommit(repo, worktree)
  writeFileSync(join(worktree, 'large.bin'), randomBytes(RUN_CHECKPOINT_MAX_BYTES + 2 * 1024 * 1024))
  const snapshot = await takeCheckpoint({ repoPath: repo, worktree, baseCommit })
  expect(snapshot?.checkpoint.unavailableReason).toBe('too_large')
  expect(Buffer.from(snapshot!.checkpoint.patch, 'base64').length).toBeLessThan(100)
  expect(() => assertCheckpointFresh(snapshot!.checkpoint)).toThrow('size limit')
})

it('a conflicting patch cannot be mistaken for a restored worktree', async () => {
  const repo = await makeRepo(), base = git(repo, 'rev-parse', 'HEAD')
  const worktree = await freshWorktree(repo, base), baseCommit = await headCommit(repo, worktree)
  writeFileSync(join(worktree, 'README.md'), 'first change\n')
  const snapshot = await takeCheckpoint({ repoPath: repo, worktree, baseCommit })
  const moved = await freshWorktree(repo, baseCommit)
  writeFileSync(join(moved, 'README.md'), 'different work\n')
  expect(await applyCheckpoint({ repoPath: repo, worktree: moved, checkpoint: snapshot!.checkpoint })).toBe(false)
})
