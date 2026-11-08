import assert from 'node:assert/strict'
import test from 'node:test'
import { taskPresentation } from './task-presentation'

const issue = { status: 'doing' as const, metadata: { pullRequests: [] } }
test('Run success is execution evidence; it cannot complete a coding task', () => {
  const state = taskPresentation(issue, { runId: 'r', status: 'succeeded', outcome: null }, { stage: 'handoff', needsYou: { kind: 'pr_review', since: '2026-11-07T00:00:00Z' } }, () => false)
  assert.deepEqual(state, { version: 1, primaryStatus: 'doing', factoryStage: 'handoff', runStatus: 'succeeded', needsAction: 'pr_review', blockedReason: null, completion: null })
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
