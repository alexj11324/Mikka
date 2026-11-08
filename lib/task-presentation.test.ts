import assert from 'node:assert/strict'
import test from 'node:test'
import { taskPresentation } from './task-presentation'

const issue = { status: 'doing' as const, metadata: { pullRequests: [] } }
test('Run success is execution evidence; it cannot complete a coding task', () => {
  const state = taskPresentation(issue, { runId: 'r', status: 'succeeded', outcome: null }, { stage: 'handoff', needsYou: { kind: 'pr_review', since: '2026-11-07T00:00:00Z' } }, () => false)
  assert.deepEqual(state, { version: 1, primaryStatus: 'doing', factoryStage: 'handoff', runStatus: 'succeeded', needsAction: 'pr_review', blockedReason: null, completion: null,
    state: 'waiting', reason: 'pr_review', blockedBy: null, group: 'pending' })
})
test('Blocked is derived and clears without rewriting the business status', () => {
  const run = { runId: 'r', status: 'waiting_input', outcome: null }
  assert.equal(taskPresentation(issue, run, null, () => false).blockedReason, 'question')
  assert.equal(taskPresentation({ ...issue, metadata: { ...issue.metadata, block: { blocked: false, runId: 'r' } } }, run, null, () => false).blockedReason, null)
  assert.equal(taskPresentation(issue, run, null, () => false).primaryStatus, 'doing')
})
test('Repository merge and deliverable acceptance keep their distinct receipts', () => {
  for (const completion of ['merged', 'accepted'] as const) {
    const state = taskPresentation({ ...issue, status: 'done' }, undefined, { stage: 'completed', completion }, () => true)
    assert.equal(state.completion, completion)
    assert.equal(state.needsAction, null)
    assert.equal(state.blockedReason, null)
  }
})
test('Cancelled work never asks for action even when an old run was blocked', () => {
  const state = taskPresentation({ ...issue, status: 'canceled' }, { runId: 'r', status: 'waiting_input', outcome: null }, { stage: 'cancelled' }, () => true)
  assert.equal(state.primaryStatus, 'canceled')
  assert.equal(state.needsAction, null)
})

test('a human pause is approval, never quota, and keeps the legacy label vocabulary', () => {
  const state = taskPresentation(issue, { runId: 'r', status: 'paused', outcome: null, pauseReason: 'human_control' }, null, () => false)
  assert.deepEqual(state, { version: 1, primaryStatus: 'doing', factoryStage: null, runStatus: 'paused', needsAction: null, blockedReason: null, completion: null,
    state: 'waiting', reason: 'approval', blockedBy: null, group: 'pending' })
})

test('current approval, quota and offline facts use the same state and compatible labels', () => {
  const examples = [
    { run: { status: 'running', awaitingApproval: true }, state: 'waiting', reason: 'approval', needsAction: null, blockedReason: null },
    { run: { status: 'paused', pauseReason: 'quota_exhausted' as const }, state: 'blocked', reason: 'quota', needsAction: 'quota', blockedReason: 'quota' },
    { run: { status: 'queued', deviceOffline: true }, state: 'blocked', reason: 'offline', needsAction: 'blocked', blockedReason: 'run' },
  ]
  for (const example of examples) {
    const result = taskPresentation(issue, { runId: 'r', outcome: null, ...example.run }, null, () => false)
    assert.deepEqual([result.state, result.reason, result.needsAction, result.blockedReason, result.group],
      [example.state, example.reason, example.needsAction, example.blockedReason, 'pending'])
    assert.equal(result.primaryStatus, 'doing')
  }
})

test('Factory attention feeds the shared state without a stale Run reason overriding it', () => {
  for (const [kind, state, reason, blockedReason] of [
    ['question', 'waiting', 'needs_input', null], ['spec_review', 'waiting', 'approval', null],
    ['pr_review', 'waiting', 'pr_review', null], ['blocked', 'blocked', 'blocked', 'factory'], ['failed', 'failed', null, 'factory'],
  ] as const) {
    const view = taskPresentation(issue, { runId: 'r', status: 'paused', outcome: null, pauseReason: 'quota_exhausted' },
      { stage: kind === 'spec_review' ? 'spec' : 'handoff', needsYou: { kind, since: '2026-11-07T00:00:00Z' } }, () => false)
    assert.deepEqual([view.state, view.reason, view.needsAction, view.blockedReason], [state, reason, kind, blockedReason])
  }
})

test('dependencies and flags annotate the shared state without raising a hand or revealing hidden identifiers', () => {
  const dependency = { ...issue, metadata: { ...issue.metadata, blockedByIds: ['visible', 'hidden'] } }
  const run = { runId: 'r', status: 'running', outcome: null }
  const visible = taskPresentation(dependency, run, null, () => true, { blockerIdentifier: id => id === 'visible' ? 'MIK-42' : null })
  assert.deepEqual([visible.state, visible.reason, visible.group, visible.blockedBy, visible.needsAction, visible.blockedReason],
    ['running', 'blocked_by', 'running', 'MIK-42', 'dependency', 'dependency'])
  const hidden = taskPresentation(dependency, undefined, null, id => id === 'hidden')
  assert.deepEqual([hidden.state, hidden.reason, hidden.group, hidden.blockedBy], ['todo', 'blocked_by', 'todo', null])
  const flagged = taskPresentation({ ...issue, metadata: { ...issue.metadata, block: { blocked: true, runId: null } } }, undefined, null, () => false)
  assert.deepEqual([flagged.state, flagged.reason, flagged.group, flagged.needsAction], ['todo', 'flagged', 'todo', 'flagged'])
})

test('a plan queues an open task and neither Run success nor a receipt rewrites business closure', () => {
  const scheduled = taskPresentation(issue, undefined, null, () => false, { schedule: { nextAt: '2030-01-01T00:00:00Z' } })
  assert.deepEqual([scheduled.state, scheduled.group], ['queued', 'running'])
  const succeeded = taskPresentation(issue, { runId: 'r', status: 'succeeded', outcome: 'done' }, null, () => false)
  assert.deepEqual([succeeded.state, succeeded.group, succeeded.primaryStatus], ['todo', 'todo', 'doing'])
  for (const completion of ['merged', 'accepted'] as const) {
    const open = taskPresentation(issue, undefined, { stage: 'completed', completion }, () => false)
    assert.deepEqual([open.state, open.primaryStatus, open.completion], ['todo', 'doing', completion])
    const closed = taskPresentation({ ...issue, status: 'done' }, { runId: 'r', status: 'paused', outcome: null, pauseReason: 'human_control' },
      { stage: 'completed', completion }, () => false)
    assert.deepEqual([closed.state, closed.reason, closed.group, closed.needsAction, closed.blockedReason], ['done', null, 'done', null, null])
  }
})
