import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { snapshotTree } from '../src/agents/publish'
import { WorktreeManager } from '../src/worktrees'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
afterEach(cleanupTempDirs)
it('keeps verification downloads out of agent staging, snapshots and continuation reports', async () => {
  const repo = await makeRepo()
  const trees = new WorktreeManager(tempDir())
  const worktree = await trees.create('verify-output', repo, 'main')
  mkdirSync(join(worktree, '.verify/debs'), { recursive: true })
  for (let i = 0; i < 452; i++) writeFileSync(join(worktree, `.verify/debs/dependency-${i}.deb`), 'download')
  writeFileSync(join(worktree, 'change.txt'), 'real change\n')
  // Agent-owned git add is protected even if the repository has no .gitignore.
  git(worktree, 'add', '-A')
  expect(git(worktree, 'diff', '--cached', '--name-only')).toBe('change.txt')
  expect(await trees.changedFiles(worktree)).toEqual(['change.txt'])
  // Force-staged artifacts still cannot enter the daemon's submitted tree.
  git(worktree, 'add', '-f', '.verify')
  const tree = await snapshotTree(repo, worktree)
  expect(git(repo, 'ls-tree', '-r', '--name-only', tree)).not.toContain('.verify/')
  expect(git(repo, 'show', `${tree}:change.txt`)).toBe('real change')
  expect(await trees.continueFrom(repo, worktree, 'verify-follow-up')).toBe(worktree)
  expect(await trees.changedFiles(worktree)).toEqual(['change.txt'])
})
