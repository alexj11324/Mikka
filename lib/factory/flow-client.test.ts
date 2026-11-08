import assert from 'node:assert/strict'
import test from 'node:test'
import { approveSpecConfirmed, approveSpecError, approveSpecErrorCode, approveSpecErrorKey, flowTone, pullRequestLink, readFlow } from './flow-client'

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

test('every answered refusal is final; only a missing answer keeps the click', () => {
  const kind = (code: string | null, status: number | null, detail?: string) => approveSpecError(code, status, detail).kind
  assert.equal(kind('factoryStale', 409), 'stale')
  assert.equal(kind('factoryReplayMismatch', 409), 'stale')
  assert.equal(kind('factoryTransition', 409), 'transition')
  assert.equal(kind('factoryEvidenceRequired', 409), 'evidence')
  assert.equal(kind('factory_visual_evidence_required', 409), 'evidence')
  assert.equal(kind('factory_public_evidence_required', 409), 'evidence')
  assert.equal(kind('factoryHumanRequired', 401), 'signedOut')
  assert.equal(kind('originRejected', 403), 'signedOut')
  assert.equal(kind('factoryNotFound', 404), 'notFound')
  assert.equal(kind('agentProfileModelUnavailable', 409, 'quota'), 'profileModel')
  assert.equal(kind('agentProfileDisabled', 409), 'profile')
  assert.equal(kind('agentProfileDecisionUnavailable', 409, 'decision_unavailable'), 'profile')
  assert.equal(kind('somethingNew', 409), 'refused')
  assert.equal(kind('factoryUnavailable', 500), 'unknown')
  assert.equal(kind(null, null), 'unknown')
})

test('a model refusal keeps its code and detail for the copy and 详情', () => {
  const quota = approveSpecError('agentProfileModelUnavailable', 409, 'quota')
  assert.deepEqual(quota, { kind: 'profileModel', code: 'agentProfileModelUnavailable', detail: 'quota' })
  assert.equal(approveSpecErrorKey(quota), 'profileModel.quota')
  assert.equal(approveSpecErrorCode(quota), 'agentProfileModelUnavailable · quota')
  assert.equal(approveSpecErrorKey(approveSpecError('agentProfileModelUnavailable', 409, 'not-a-detail')), 'profileModel.default')
  assert.equal(approveSpecErrorKey(approveSpecError('agentProfileDisabled', 409)), 'profileDisabled')
  assert.equal(approveSpecErrorCode(approveSpecError('agentProfileDisabled', 409)), 'agentProfileDisabled')
  assert.equal(approveSpecErrorCode(approveSpecError('factoryStale', 409)), null)
  assert.equal(approveSpecErrorCode(approveSpecError(null, null)), null)
})

test('each reachable Profile state and Decision refusal has its own copy without changing click semantics', () => {
  for (const [code, key] of [
    ['agentProfileUnavailable', 'profile'],
    ['agentProfileDisabled', 'profileDisabled'],
    ['agentProfileArchived', 'profileArchived'],
    ['agentProfileVersionConflict', 'profileVersionConflict'],
  ]) {
    const failure = approveSpecError(code, 409)
    assert.deepEqual(failure, { kind: 'profile', code, detail: null })
    assert.equal(approveSpecErrorKey(failure), key)
    assert.equal(approveSpecErrorCode(failure), code)
  }
  for (const detail of ['decision_unavailable', 'no_suitable_profile', 'invalid_profile_answer', 'unknown_profile', 'uncertain_profile', 'invalid_reason']) {
    const failure = approveSpecError('agentProfileDecisionUnavailable', 409, detail)
    assert.deepEqual(failure, { kind: 'profile', code: 'agentProfileDecisionUnavailable', detail })
    assert.equal(approveSpecErrorKey(failure), 'profileDecision.' + detail)
    assert.equal(approveSpecErrorCode(failure), 'agentProfileDecisionUnavailable · ' + detail)
  }
  // A future code/detail keeps the existing Profile fallback, never guessed copy.
  assert.equal(approveSpecErrorKey(approveSpecError('agentProfileFuture', 409)), 'profile')
  assert.equal(approveSpecErrorKey(approveSpecError('agentProfileDecisionUnavailable', 409)), 'profile')
  assert.equal(approveSpecErrorKey(approveSpecError('agentProfileDecisionUnavailable', 409, 'future_detail')), 'profile')
  assert.equal(approveSpecErrorKey(approveSpecError('agentProfileDisabled', 503)), 'unknown')
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
