import assert from 'node:assert/strict'
import test from 'node:test'
import {
  environmentActionCwd, environmentAllowsRepository, environmentConfigSchema, environmentSetupCommand,
  environmentSnapshotSchema, isTerminalRunActionStatus, normalizeEnvironmentRepositories, safeRelativeWorkdir,
} from './contract'

const action = { id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', name: 'test', kind: 'test' as const, command: 'pnpm test', timeoutSeconds: 120 }
const config = {
  name: 'Node', description: '', runtime: 'cloud' as const, workdir: 'apps/web',
  setupScript: 'pnpm db:migrate', installScript: 'pnpm install', actions: [action],
  repositories: ['v2/github.com/acme/app'],
}

test('a complete environment parses; every relative workdir form stays inside the worktree', () => {
  assert.equal(environmentConfigSchema.parse(config).name, 'Node')
  for (const value of ['', 'apps/web', 'packages/app-1', 'a_b.c']) assert.equal(safeRelativeWorkdir(value), true, value)
  for (const value of ['/etc', '../x', 'a/../b', 'a//b', 'a b', 'a\\b', './a', 'a/./b']) assert.equal(safeRelativeWorkdir(value), false, value)
})

test('duplicate action ids and repository spellings are rejected before storage', () => {
  assert.equal(environmentConfigSchema.safeParse({ ...config, actions: [action, { ...action, name: 'again' }] }).success, false)
  assert.equal(environmentConfigSchema.safeParse({ ...config, repositories: ['v2/a/b', 'v2/a/b'] }).success, false)
  assert.equal(environmentConfigSchema.safeParse({ ...config, actions: [{ ...action, kind: 'deploy' }] }).success, false)
  assert.equal(environmentConfigSchema.safeParse({ ...config, workdir: '..' }).success, false)
})

test('scripts are bounded by UTF-8 bytes, not characters', () => {
  assert.equal(environmentConfigSchema.safeParse({ ...config, setupScript: 'x'.repeat(4001) }).success, false)
  assert.equal(environmentConfigSchema.safeParse({ ...config, setupScript: '测'.repeat(1334) }).success, false)
  assert.equal(environmentConfigSchema.safeParse({ ...config, setupScript: '测'.repeat(1333) }).success, true)
})

test('repository input normalizes to one logical key per repository', () => {
  assert.deepEqual(normalizeEnvironmentRepositories(['acme/app', 'https://github.com/acme/app.git', 'git@github.com:acme/app.git']), ['v2/github.com/acme/app'])
  assert.throws(() => normalizeEnvironmentRepositories(['file:///tmp/repo']), /Invalid repository/)
})

test('the claim setup command runs install then setup in the workdir under set -e', () => {
  const snapshot = environmentSnapshotSchema.parse({ ...config, environmentId: '11111111-1111-4111-8111-111111111111', revision: 2 })
  assert.equal(environmentSetupCommand(snapshot), "set -e\ncd -- 'apps/web'\npnpm install\npnpm db:migrate")
  assert.equal(environmentSetupCommand({ workdir: '', installScript: '', setupScript: 'echo hi' }), 'set -e\necho hi')
  assert.equal(environmentSetupCommand({ workdir: 'apps/web', installScript: '', setupScript: '' }), null)
  assert.equal(environmentSetupCommand({ workdir: '', installScript: '', setupScript: "echo 'x'" }), "set -e\necho 'x'")
})

test('an empty allow-list admits every repository; a populated one is exact', () => {
  assert.equal(environmentAllowsRepository({ repositories: [] }, 'v2/github.com/acme/app'), true)
  assert.equal(environmentAllowsRepository({ repositories: ['v2/github.com/acme/app'] }, 'v2/github.com/acme/app'), true)
  assert.equal(environmentAllowsRepository({ repositories: ['v2/github.com/acme/app'] }, 'v2/github.com/acme/other'), false)
})

test('the action cwd joins the frozen worktree and the validated workdir', () => {
  assert.equal(environmentActionCwd('/home/user/.mikka/worktrees/run-1', ''), '/home/user/.mikka/worktrees/run-1')
  assert.equal(environmentActionCwd('/home/user/.mikka/worktrees/run-1/', 'apps/web'), '/home/user/.mikka/worktrees/run-1/apps/web')
})

test('only terminal statuses free the run for the next action', () => {
  for (const status of ['succeeded', 'failed', 'cancelled', 'timed_out'] as const) assert.equal(isTerminalRunActionStatus(status), true)
  for (const status of ['queued', 'running'] as const) assert.equal(isTerminalRunActionStatus(status), false)
})
