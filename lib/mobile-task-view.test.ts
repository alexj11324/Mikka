import assert from 'node:assert/strict'
import test from 'node:test'
import { mobileTaskActivity, mobileTaskGroup, type MobileTaskAttempt } from './mobile-task-view'
import type { ThreadOutcome } from './thread-groups'

const task = (status = 'todo', states: ('open' | 'draft' | 'merged' | 'closed')[] = []) => ({ status, metadata: { pullRequests: states.map(state => ({ url: 'https://github.com/acme/app/pull/1', state })) } })
const run = (status: string, outcome: ThreadOutcome | null = null) => ({ runId: 'run', status, outcome })

test('compatibility group entry point delegates to task state', () => {
  assert.equal(mobileTaskGroup(task(), run('failed')), 'pending')
  assert.equal(mobileTaskGroup(task(), undefined, { block: { reason: 'flagged' } }), 'todo')
  assert.equal(mobileTaskGroup(task(), run('succeeded', 'done')), 'todo')
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

 test('activity PRs belong to the exact publication, never the task metadata', () => {
  const rows = ['https://github.com/acme/app/pull/42', null, 'invalid'].map((url, index) => ({ ...run('succeeded', 'done'), runId: String(index), harness: 'codex', createdAt: new Date(index + 1), threadReplacedBy: null, pullRequest: url ? { url } : null }))
  const activity = mobileTaskActivity(task('review', ['open']), rows, { by: null, createdAt: new Date(0) })
  const attempts = activity.filter(row => row.kind === 'attempt').toReversed()
  assert.deepEqual(attempts.map(row => row.pullRequest), [{ number: 42, url: rows[0].pullRequest!.url }, null, null])
  assert.deepEqual(attempts.map(row => row.state), ['done', 'done', 'done'])
})
