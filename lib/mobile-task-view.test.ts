import assert from 'node:assert/strict'
import test from 'node:test'
import { mobileTaskActivity, mobileTaskGroup, type MobileTaskGroup, type MobileTaskAttempt } from './mobile-task-view'
import type { ThreadOutcome } from './thread-groups'

const task = (status = 'todo', states: ('open' | 'draft' | 'merged' | 'closed')[] = []) => ({ status, metadata: { pullRequests: states.map(state => ({ url: 'https://github.com/acme/app/pull/1', state })) } })
const run = (status: string, outcome: ThreadOutcome | null = null) => ({ runId: 'run', status, outcome })

test('task groups cover every R-52 branch, including PR metadata and closed-task precedence', () => {
  const cases: [string, ThreadOutcome | null, MobileTaskGroup][] = [
    ...['queued', 'preparing', 'running', 'finishing'].map(status => [status, null, 'running'] as [string, null, MobileTaskGroup]),
    ['waiting_input', null, 'pending'], ['paused', null, 'pending'],
    ['succeeded', 'blocked', 'pending'], ['succeeded', 'failed', 'pending'], ['succeeded', 'needs_input', 'pending'],
    ['succeeded', 'idle', 'todo'], ['succeeded', 'done', 'done'], ['succeeded', null, 'pending'], ['failed', null, 'pending'],
  ]
  for (const [status, outcome, expected] of cases) assert.equal(mobileTaskGroup(task(), run(status, outcome)), expected, `${status}/${outcome}`)
  assert.equal(mobileTaskGroup(task()), 'todo')
  for (const status of ['done', 'canceled', 'duplicate']) {
    assert.equal(mobileTaskGroup(task(status), run('running')), 'done')
    assert.equal(mobileTaskGroup(task(status)), 'done')
  }
  for (const state of ['open', 'draft'] as const) assert.equal(mobileTaskGroup(task('todo', [state]), run('succeeded', 'idle')), 'pending')
  assert.equal(mobileTaskGroup(task('review'), run('succeeded', 'done')), 'pending')
  assert.equal(mobileTaskGroup(task('todo', ['merged']), run('succeeded')), 'done')
  assert.equal(mobileTaskGroup(task('todo', ['closed']), run('succeeded', 'idle')), 'todo')
  assert.equal(mobileTaskGroup(task('todo', ['merged']), run('running')), 'running')
  assert.equal(mobileTaskGroup(task('review'), run('succeeded', 'blocked')), 'pending')
})

test('a task without a thread is pending when the board blocks it; closed tasks still win', () => {
  assert.equal(mobileTaskGroup(task(), undefined, true), 'pending')
  assert.equal(mobileTaskGroup(task(), undefined, false), 'todo')
  assert.equal(mobileTaskGroup(task(), run('running'), true), 'pending')
  assert.equal(mobileTaskGroup(task(), run('succeeded', 'idle'), true), 'pending')
  for (const status of ['done', 'canceled', 'duplicate']) assert.equal(mobileTaskGroup(task(status), undefined, true), 'done')
})

test('activity numbers chronologically, sorts newest first, and keeps same-time replacements stable', () => {
  const attempt = (id: string, at: number, extra: Partial<MobileTaskAttempt> = {}): MobileTaskAttempt => ({ ...run('succeeded', 'idle'), runId: id, harness: 'codex', createdAt: new Date(at), threadReplacedBy: null, ...extra })
  const first = attempt('a', 1000, { threadReplacedBy: 'b', status: 'failed' })
  const second = attempt('b', 2000, { outcome: 'failed' })
  const last = attempt('c', 3000)
  const created = { by: 'Owner', createdAt: new Date(0) }
  const result = mobileTaskActivity(task(), [last, first, second], created)
  assert.deepEqual(result.map(row => [row.kind, 'runId' in row ? row.runId : row.by]), [['attempt', 'c'], ['attempt', 'b'], ['replaced', 'b'], ['attempt', 'a'], ['created', 'Owner']])
  assert.deepEqual(result.filter(row => row.kind === 'attempt').map(row => [row.n, row.failed]), [[3, false], [2, true], [1, true]])
  assert.deepEqual(result.filter(row => row.kind === 'attempt').map(row => row.group), ['idle', 'blocked', 'idle'])
  assert.equal(result[2].createdAt, second.createdAt.toISOString())
  assert.deepEqual(mobileTaskActivity(task(), [second, last, first], created), result)
  assert.deepEqual(mobileTaskActivity(task(), [], created), [{ kind: 'created', by: 'Owner', createdAt: new Date(0).toISOString() }])
  const ties = [attempt('b', 1000), attempt('a', 1000)]
  assert.deepEqual(mobileTaskActivity(task(), ties, created), mobileTaskActivity(task(), ties.toReversed(), created))
})

test('attempt groups preserve the R-52 vocabulary expected by the iOS attempt status labels', () => {
  const expected = ['running', 'waiting', 'blocked', 'idle', 'resolved']
  const runs: MobileTaskAttempt[] = [run('running'), run('waiting_input'), run('paused'), run('succeeded', 'idle'), run('succeeded', 'done')]
    .map((item, index) => ({ ...item, runId: String(index), harness: 'codex', createdAt: new Date(index + 1), threadReplacedBy: null }))
  const activity = mobileTaskActivity(task(), runs, { by: null, createdAt: new Date(0) })
  assert.deepEqual(activity.filter(row => row.kind === 'attempt').toReversed().map(row => row.group), expected)
})
