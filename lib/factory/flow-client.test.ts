import assert from 'node:assert/strict'
import test from 'node:test'
import { approveSpecConfirmed, approveSpecError, flowTone, pullRequestLink, readFlow } from './flow-client'

const flow = (patch: Record<string, unknown> = {}) => ({ version: 2, id: 't1', issueId: 'i1', botId: 'b1', revision: 4, stage: 'spec', stages: ['spec'], review: null, acceptance: null, pullRequest: null, ...patch })

test('only the v2 projection reads as a flow; unknown stages and kinds are dropped', () => {
  assert.equal(readFlow({}), null)
  assert.equal(readFlow(flow({ version: 1 })), null)
  assert.equal(readFlow(flow({ stage: 'verify' })), null)
  const read = readFlow(flow({ stages: ['triage', 'verify', 'spec'], needsYou: { kind: 'waiting_input', since: '2026-11-05T00:00:00.000Z' } }))
  assert.deepEqual(read?.stages, ['triage', 'spec'])
  assert.equal(read?.needsYou, undefined)
  // The current stage is always in the list, even when history omitted it.
  assert.deepEqual(readFlow(flow({ stage: 'implement', stages: ['spec'] }))?.stages, ['spec', 'implement'])
})

test('needing the person is amber, a stop is red, a merge is green (R-87)', () => {
  assert.equal(flowTone({ stage: 'spec', needsYou: { kind: 'spec_review', since: '' } }), 'warning')
  assert.equal(flowTone({ stage: 'handoff', needsYou: { kind: 'pr_review', since: '' } }), 'warning')
  assert.equal(flowTone({ stage: 'implement', needsYou: { kind: 'failed', since: '' } }), 'destructive')
  assert.equal(flowTone({ stage: 'implement', needsYou: { kind: 'blocked', since: '' } }), 'destructive')
  assert.equal(flowTone({ stage: 'implement' }), 'info')
  assert.equal(flowTone({ stage: 'completed' }), 'success')
  assert.equal(flowTone({ stage: 'cancelled' }), 'neutral')
})

test('an approval refusal is final; only a missing answer keeps the click', () => {
  assert.equal(approveSpecError('factoryStale', 409), 'stale')
  assert.equal(approveSpecError('factoryReplayMismatch', 409), 'stale')
  assert.equal(approveSpecError('factoryTransition', 409), 'transition')
  assert.equal(approveSpecError('factoryEvidenceRequired', 409), 'evidence')
  assert.equal(approveSpecError('factoryHumanRequired', 401), 'signedOut')
  assert.equal(approveSpecError('originRejected', 403), 'signedOut')
  assert.equal(approveSpecError('factoryNotFound', 404), 'notFound')
  assert.equal(approveSpecError('factoryUnavailable', 500), 'unknown')
  assert.equal(approveSpecError(null, null), 'unknown')
})

test('the receipt must name this task and the implementation stage', () => {
  assert.equal(approveSpecConfirmed({ binding: { taskId: 't1', revision: 6 }, stage: 'implement', replayed: true }, 't1'), true)
  assert.equal(approveSpecConfirmed({ binding: { taskId: 't2', revision: 6 }, stage: 'implement' }, 't1'), false)
  assert.equal(approveSpecConfirmed({ deferred: true }, 't1'), false)
})

test('only a GitHub pull request URL is offered as a link', () => {
  assert.equal(pullRequestLink({ pullRequest: { url: 'https://github.com/o/r/pull/12', state: 'open' } }), 'https://github.com/o/r/pull/12')
  assert.equal(pullRequestLink({ pullRequest: { url: 'javascript:alert(1)', state: 'open' } }), null)
  assert.equal(pullRequestLink({ pullRequest: null }), null)
})
