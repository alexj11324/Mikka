import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorktreeManager } from '../src/worktrees'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(() => cleanupTempDirs())

it('executes approved environment setup with only the controlled task variables', async () => {
  const repo = await makeRepo()
  const manager = new WorktreeManager(tempDir())
  const worktree = await manager.create('environment-test', repo, 'main')
  const command = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('environment-proof.json',JSON.stringify({mode:process.env.FEATURE_MODE,reserved:process.env.MIKKA_INJECTED??null}))"`
  await manager.bootstrap(worktree, repo, { copyFiles: [], command, approved: true }, { FEATURE_MODE: 'project-config', MIKKA_INJECTED: 'blocked' })
  expect(JSON.parse(readFileSync(join(worktree, 'environment-proof.json'), 'utf8'))).toEqual({ mode: 'project-config', reserved: null })
})

it('does not execute an unapproved setup recipe', async () => {
  const repo = await makeRepo()
  const manager = new WorktreeManager(tempDir())
  const worktree = await manager.create('unapproved-environment', repo, 'main')
  await manager.bootstrap(worktree, repo, { copyFiles: [], command: 'touch unexpected', approved: false }, { FEATURE_MODE: 'project-config' })
  expect(existsSync(join(worktree, 'unexpected'))).toBe(false)
})
