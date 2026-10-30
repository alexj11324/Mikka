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

test('completed A cannot settle while a known workflow B is queued or a required check is missing', () => {
  const base = { checks: [check('success')], statuses: [] }
  const missing = { ...base, requiredChecks: [{ context: 'test-B', appId: 123 }] }
  assert.equal(summarize(missing).kind, 'pending')
  assert.equal(summarize({ ...base, workflows: [{ id: '2', attempt: 1, name: 'B', status: 'queued', conclusion: null }] }).kind, 'pending')
  assert.equal(summarize({ ...missing, checks: [...base.checks, { ...check('success'), id: '2', name: 'test-B', appId: 999 }] }).kind, 'pending')
  const all = { ...missing, checks: [...base.checks, { ...check('success'), id: '2', name: 'test-B', appId: 123 }] }
  assert.equal(summarize(all).kind, 'complete')
  assert.equal(summarize({ ...all, unknownRequiredWorkflow: true }).kind, 'pending')
})

test('newer same workflow and trigger supersedes an older failure', () => {
  const base = { checks: [check('success')], statuses: [] }
  const previous = { id: '10', attempt: 1, name: 'deploy', status: 'completed', conclusion: 'failure', workflowId: '5', event: 'workflow_dispatch', createdAt: '2026-10-30T00:00:00Z' }
  const latest = { ...previous, id: '11', conclusion: 'success', createdAt: '2026-10-30T00:01:00Z' }
  const result = summarize({ ...base, workflows: [previous, latest] })
  assert.equal(result.kind, 'complete')
  if (result.kind === 'complete') assert.equal(result.outcome, 'success')
  assert.equal(summarize({ ...base, workflows: [latest, { ...previous, status: 'in_progress', conclusion: null }] }).kind, 'pending')
})

test('superseded workflow suite cannot fail or satisfy a later required check', () => {
  const old = { id: '10', attempt: 1, name: 'build', status: 'completed', conclusion: 'failure', workflowId: '5', event: 'pull_request', createdAt: '2026-10-30T00:00:00Z', suiteId: '20' }
  const current = { ...old, id: '11', conclusion: 'success', createdAt: '2026-10-30T00:01:00Z', suiteId: '21' }
  const checks = [{ ...check('failure'), id: '100', name: 'job', suiteId: '20' }]
  assert.equal(summarize({ checks, statuses: [], workflows: [old, current], requiredChecks: [{ context: 'job', appId: null }] }).kind, 'pending')
  const result = summarize({ checks: [...checks, { ...check('success'), id: '101', name: 'job', suiteId: '21' }], statuses: [], workflows: [old, current], requiredChecks: [{ context: 'job', appId: null }] })
  assert.equal(result.kind, 'complete')
  if (result.kind === 'complete') assert.equal(result.outcome, 'success')
})

test('rerunning an older same-SHA workflow cannot hide a newer attempt failure', () => {
  const oldRerun = { id: '10', attempt: 2, name: 'build', status: 'completed', conclusion: 'failure', workflowId: '5', event: 'pull_request', createdAt: '2026-10-30T00:00:00Z', suiteId: '20' }
  const newer = { ...oldRerun, id: '11', attempt: 1, conclusion: 'success', createdAt: '2026-10-30T00:01:00Z', suiteId: '21' }
  assert.deepEqual(summarize({ checks: [{ ...check('failure'), suiteId: '20' }, { ...check('success'), id: '2', suiteId: '21' }], statuses: [], workflows: [oldRerun, newer] }), { kind: 'pending', reason: 'ambiguous_workflow_order' })
})
