import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from 'vitest'
import { WorktreeManager } from '../src/worktrees'

test('retained acceptance worktrees survive explicit removal, pruning and empty-run discard', async () => {
  // Deliberately retained: this test has no cleanup hook.
  const root = await mkdtemp(join(tmpdir(), 'mikka-retained-worktree-'))
  const runId = '10000000-0000-4000-8000-000000000001'
  const manager = new WorktreeManager(root, true)
  const worktree = manager.pathFor(runId)
  await mkdir(worktree)
  const evidence = join(worktree, 'acceptance-evidence.txt')
  await writeFile(evidence, 'retained')
  await manager.remove(runId, root)
  expect(await readFile(evidence, 'utf8')).toBe('retained')
  expect(await manager.prune([{ runId, repoPath: root, finishedAt: '2000-01-01T00:00:00Z' }], 0)).toEqual([])
  expect(await manager.discardIfEmpty([runId], worktree, root)).toBe(false)
  expect(await readFile(evidence, 'utf8')).toBe('retained')
  console.info(`Retained acceptance fixture: ${root}`)
})
