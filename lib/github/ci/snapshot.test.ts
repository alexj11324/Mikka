import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { summarize } from './snapshot'

const check = (conclusion: string | null, status = 'completed') => ({ id: '1', name: 'build', status, conclusion })

test('waits for checks, status contexts and terminal states', () => {
  assert.deepEqual(summarize({ checks: [], statuses: [] }), { kind: 'pending' })
  assert.deepEqual(summarize({ checks: [check(null, 'in_progress')], statuses: [] }), { kind: 'pending' })
  assert.deepEqual(summarize({ checks: [check('success')], statuses: [{ id: '1', context: 'deploy', state: 'pending' }] }), { kind: 'pending' })
})

test('only success is success, including unusual completed conclusions', () => {
  assert.equal(summarize({ checks: [check('success')], statuses: [] }).kind, 'complete')
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure']) {
    const result = summarize({ checks: [check(conclusion)], statuses: [] })
    assert.equal(result.kind, 'complete')
    if (result.kind === 'complete') { assert.equal(result.outcome, 'failure'); assert.deepEqual(result.failed, ['build']) }
  }
})

test('fingerprint ignores provider ordering but distinguishes new attempts', () => {
  const a = { checks: [check('success'), { ...check('failure'), id: '2', name: 'test' }], statuses: [] }
  const first = summarize(a), reordered = summarize({ ...a, checks: [...a.checks].reverse() })
  assert.deepEqual(first, reordered)
  const rerun = summarize({ ...a, checks: [a.checks[0], { ...a.checks[1], id: '3' }] })
  assert.notDeepEqual(first, rerun)
})

test('conditionally skipped and neutral checks require a real success and unknown conclusions wait', () => {
  for (const conclusion of ['skipped', 'neutral']) {
    assert.equal(summarize({ checks: [check(conclusion)], statuses: [] }).kind, 'pending')
    const result = summarize({ checks: [check('success'), { ...check(conclusion), id: '2', name: 'optional' }], statuses: [] })
    assert.equal(result.kind, 'complete')
    if (result.kind === 'complete') assert.equal(result.outcome, 'success')
  }
  assert.equal(summarize({ checks: [check('new-conclusion')], statuses: [] }).kind, 'pending')
})

test('same check IDs on a new workflow attempt produce a new fingerprint, and an active attempt waits', () => {
  const snapshot = { checks: [check('success')], statuses: [] }
  const a = summarize(snapshot, [{ runId: '12', attempt: 1, state: 'completed' }])
  const b = summarize(snapshot, [{ runId: '12', attempt: 2, state: 'completed' }])
  assert.notDeepEqual(a, b)
  assert.equal(summarize(snapshot, [{ runId: '12', attempt: 2, state: 'in_progress' }]).kind, 'pending')
})
