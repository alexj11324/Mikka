import assert from 'node:assert/strict'
import test from 'node:test'
import { attemptStateOf, taskGroupOf, taskStateOf, type TaskStateRun } from './task-state'
import type { BlockIssue } from './task-blocked'

const task = (status = 'todo', prs: string[] = []): BlockIssue => ({ status, metadata: { pullRequests: prs.map(state => ({ url: 'https://github.com/acme/app/pull/1', state: state as 'open' })) } })
const run = (status: string, extra: Partial<TaskStateRun> = {}): TaskStateRun => ({ runId: 'run', status, outcome: null, ...extra })
const failure = (category: 'subscription' | 'api_key' | 'quota' | 'access_denied' | 'timeout'): NonNullable<TaskStateRun['failureDetails']> => ({ schemaVersion: 1, code: 'run_failed', category, runId: 'run', occurredAt: '2026-11-07T00:00:00Z', appVersion: 'test' })
const expect = (issue: BlockIssue, attempt: TaskStateRun | null, state: string, reason: string | null = null) => assert.deepEqual(taskStateOf(issue, attempt), { state, reason, blockedBy: null, group: taskGroupOf(state as Parameters<typeof taskGroupOf>[0]) })

test('all task states and groups, with task-owned closure taking precedence over attempts and PRs', () => {
  for (const status of ['done', 'canceled', 'duplicate'] as const) {
    expect(task(status, ['open']), run('running'), status)
    expect(task(status), null, status)
  }
  for (const status of ['preparing', 'running', 'finishing']) expect(task(), run(status), 'running')
  expect(task(), run('queued'), 'queued')
  expect(task(), run('failed'), 'failed')
  expect(task(), run('succeeded', { outcome: 'failed' }), 'failed')
  for (const status of ['todo', 'backlog', 'doing']) expect(task(status), null, 'todo')
  for (const outcome of [null, 'done', 'idle'] as const) expect(task('todo', ['merged']), run('succeeded', { outcome }), 'todo')
  expect(task(), run('failed', { threadReplacedBy: 'replacement' }), 'todo')
  for (const status of ['stopped', 'cancelled']) expect(task(), run(status), 'todo')
  assert.deepEqual(taskStateOf(task(), null, { schedule: { nextAt: '2030-01-01T00:00:00Z' } }), { state: 'queued', reason: null, blockedBy: null, group: 'running' })
  assert.equal(taskStateOf(task(), null, { schedule: { nextAt: null } }).state, 'todo')
  assert.deepEqual(['waiting','blocked','failed','running','queued','todo','done','canceled','duplicate'].map(state => taskGroupOf(state as Parameters<typeof taskGroupOf>[0])), ['pending','pending','pending','running','running','todo','done','done','done'])
})

test('waiting distinguishes input, approval and PR review; active and failed attempts beat PR metadata', () => {
  expect(task(), run('waiting_input'), 'waiting', 'needs_input')
  expect(task(), run('succeeded', { outcome: 'needs_input' }), 'waiting', 'needs_input')
  expect(task(), run('failed', { outcome: 'needs_input' }), 'waiting', 'needs_input')
  expect(task(), run('running', { awaitingApproval: true }), 'waiting', 'approval')
  expect(task(), run('paused', { pauseReason: 'human_control' }), 'waiting', 'approval')
  expect(task('review'), null, 'waiting', 'pr_review')
  for (const state of ['open', 'draft']) expect(task('todo', [state]), run('succeeded', { outcome: 'done' }), 'waiting', 'pr_review')
  expect(task('todo', ['closed']), null, 'todo')
  expect(task('review'), run('running'), 'running')
  expect(task('review'), run('failed'), 'failed')
})

test('blocked distinguishes login, key, permission, quota and offline using bounded facts', () => {
  for (const category of ['subscription', 'api_key', 'access_denied'] as const) expect(task(), run('failed', { failureDetails: failure(category) }), 'blocked', 'blocked')
  expect(task(), run('succeeded', { outcome: 'blocked' }), 'blocked', 'blocked')
  expect(task(), run('paused'), 'blocked', 'quota')
  expect(task(), run('paused', { pauseReason: 'quota_exhausted' }), 'blocked', 'quota')
  expect(task(), run('failed', { stopReason: 'quota_exhausted' }), 'blocked', 'quota')
  expect(task(), run('failed', { failureDetails: failure('quota') }), 'blocked', 'quota')
  expect(task(), run('failed', { failureDetails: { ...failure('timeout'), code: 'run_quota_exceeded' } }), 'blocked', 'quota')
  expect(task(), run('queued', { deviceOffline: true }), 'blocked', 'offline')
  expect(task(), run('queued', { waitingFor: { deviceId: 'device' } }), 'blocked', 'offline')
  expect(task(), run('failed', { stopReason: 'device_lost' }), 'blocked', 'offline')
  expect(task(), run('failed', { failureDetails: failure('timeout') }), 'failed')
})

test('dependency and flag reasons preserve the task state; only dependency exposes its identifier', () => {
  for (const [block, reason, blockedBy] of [
    [{ reason: 'dependency', blockerId: 'private-id', blockerIdentifier: 'MIK-12' }, 'blocked_by', 'MIK-12'],
    [{ reason: 'dependency', blockerId: 'private-id' }, 'blocked_by', null],
    [{ reason: 'flagged' }, 'flagged', null],
  ] as const) {
    for (const [attempt, state, group] of [[null, 'todo', 'todo'], [run('running'), 'running', 'running'], [run('queued'), 'queued', 'running']] as const) {
      assert.deepEqual(taskStateOf(task(), attempt, { block }), { state, reason, blockedBy, group })
    }
    assert.equal(taskStateOf(task('done'), null, { block }).reason, null)
    assert.equal(taskStateOf(task(), run('waiting_input'), { block }).reason, 'needs_input')
  }
})

test('every attempt state comes from that attempt, with replacement precedence and no waiting', () => {
  for (const status of ['queued', 'preparing', 'running', 'finishing']) assert.equal(attemptStateOf(run(status)), 'running')
  for (const item of [run('waiting_input'), run('succeeded', { outcome: 'needs_input' }), run('running', { awaitingApproval: true }), run('paused', { pauseReason: 'human_control' })]) assert.equal(attemptStateOf(item), 'paused')
  for (const status of ['succeeded', 'stopped', 'cancelled']) assert.equal(attemptStateOf(run(status)), 'done')
  for (const item of [run('failed'), run('succeeded', { outcome: 'failed' })]) assert.equal(attemptStateOf(item), 'failed')
  for (const item of [run('paused'), run('succeeded', { outcome: 'blocked' }), run('queued', { deviceOffline: true })]) assert.equal(attemptStateOf(item), 'blocked')
  assert.equal(attemptStateOf(run('failed', { threadReplacedBy: 'next' })), 'replaced')
})
