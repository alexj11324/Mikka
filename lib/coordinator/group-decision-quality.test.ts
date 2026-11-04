import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createGroupDecisionTrace, groupDecisionReceipt, groupDecisionSteps } from './group-decision-trace'
import { compareGroupPolicies, evaluateGroupDecisions, groupTraceObservation, type GroupEvalCase, type GroupEvalObservation } from './group-decision-eval'
import { getGroupDecisionPolicy, GROUP_BASELINE_VERSION, GROUP_POLICY_VERSION, GROUP_LIVE_POLICY_VERSION, GROUP_PREVIOUS_POLICY_VERSION } from './group-decision-policy'
import { groupFeedbackInput } from './group-decision-feedback'
import { groupDecisionReplayInput } from './group-decision-replay-api'
import type { GroupDecisionStep } from './group-decision-chain'
import { DECISION_MODEL } from './decision'
import { overrideDeploymentSwitch } from '../deployment-switches'

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/group-decision-cases.json', import.meta.url), 'utf8')) as { cases: GroupEvalCase[] }
const observed = (item: GroupEvalCase): GroupEvalObservation => ({ caseId: item.id, action: item.expected.actions[0], responders: item.expected.responders ?? ['primary'],
  wakes: item.expected.intervene ? 1 : 0, generations: item.expected.intervene && !item.expected.delegate ? 1 : 0,
  published: item.expected.intervene && !item.expected.delegate ? 1 : 0, delegated: item.expected.delegate ? 1 : 0,
  delegationCompleted: item.expected.delegate || undefined, duplicatePublicMessages: 0, latencyMs: null, costUsd: null,
  status: item.expected.intervene === null ? 'blocked' : 'complete' })

test('deployment rollback changes live policy while host-selected replay versions stay fixed',t=>{
  t.after(()=>overrideDeploymentSwitch('groupContribution',undefined))
  overrideDeploymentSwitch('groupContribution',false)
  assert.equal(getGroupDecisionPolicy().version,GROUP_BASELINE_VERSION)
  assert.equal(getGroupDecisionPolicy(GROUP_POLICY_VERSION).version,GROUP_POLICY_VERSION)
  overrideDeploymentSwitch('groupContribution',true)
  assert.equal(GROUP_LIVE_POLICY_VERSION,GROUP_PREVIOUS_POLICY_VERSION,'candidate inference must pass before live promotion')
  assert.notEqual(GROUP_LIVE_POLICY_VERSION,GROUP_POLICY_VERSION)
  assert.equal(getGroupDecisionPolicy().version,GROUP_LIVE_POLICY_VERSION)
  assert.equal(getGroupDecisionPolicy(GROUP_BASELINE_VERSION).version,GROUP_BASELINE_VERSION)
})

test('trace snapshots detect duty/authorization changes without copying role instructions or extra fields', () => {
  const member = { id: 'member', name: 'Coding', description: 'private-shaped fixture text', capabilities: ['factory'], executionAvailable: true, token: 'never-copy-this' }
  const first = createGroupDecisionTrace([member], ['context'])
  assert.equal(first.policyVersion, GROUP_LIVE_POLICY_VERSION)
  assert.equal(first.members[0].executionAvailable, true)
  assert.ok(!JSON.stringify(first).includes(member.description))
  assert.ok(!JSON.stringify(first).includes(member.token))
  assert.notEqual(createGroupDecisionTrace([{ ...member, description: 'new duty' }], []).memberVersion, first.memberVersion)
  assert.notEqual(createGroupDecisionTrace([{ ...member, executionAvailable: false }], []).memberVersion, first.memberVersion)
})

test('receipt allowlist drops private envelopes and rejects malformed or forged model metadata', () => {
  const receipt = { executionId: 'execution', modelId: DECISION_MODEL as typeof DECISION_MODEL, providerGenerationId: 'provider', startedAt: '2026-11-03T00:00:00Z', completedAt: '2026-11-03T00:00:01Z', requestDigest: 'a'.repeat(64), imageDigests: [], vision: 'no-image-input' as const, credential: 'never-copy-this' }
  assert.equal(groupDecisionReceipt(receipt)?.requestDigest, receipt.requestDigest)
  assert.ok(!JSON.stringify(groupDecisionReceipt(receipt)).includes(receipt.credential))
  assert.equal(groupDecisionReceipt({ ...receipt, requestDigest: 'invalid' }), null)
  assert.equal(groupDecisionReceipt({ ...receipt, completedAt: '2025-01-01' }), null)
  assert.equal(groupDecisionReceipt({ ...receipt, modelId: 'forged' as typeof DECISION_MODEL }), null)
})

test('offline replay distinguishes false wakes from useful silent delegation and preserves unknown cost', () => {
  const candidate = fixture.cases.map(observed)
  const baseline = candidate.map(item => item.caseId === 'small-talk' ? { ...item, action: 'reply', responders: ['primary'], wakes: 1, generations: 1, published: 1 } : item)
  const result = compareGroupPolicies(fixture.cases, baseline, candidate)
  assert.equal(result.baseline.falseWake, 1)
  assert.equal(result.candidate.falseWake, 0)
  assert.equal(result.candidate.missedUsefulIntervention, 0)
  assert.equal(result.candidate.delegationCompletionRate, 1)
  assert.equal(result.candidate.cost.knownObservations, 0)
  assert.equal(result.candidate.cost.unknownObservations, candidate.length)
  assert.equal(result.reviewReady, true)
  assert.equal(result.requiresHumanReview, true)
})

test('review gate rejects missing cases, wrong members, missed help and increased public noise', () => {
  const baseline = fixture.cases.map(observed)
  assert.ok(compareGroupPolicies(fixture.cases, baseline, baseline.slice(1)).blocked.includes('incomplete_dataset'))
  const regressed = baseline.map(item => item.caseId === 'ui-help' ? { ...item, action: 'ignore', responders: [], wakes: 0, generations: 0, published: 0 } : item)
  assert.ok(compareGroupPolicies(fixture.cases, baseline, regressed).blocked.includes('recall_regression'))
  const wrong = baseline.map(item => item.caseId === 'testing-help' ? { ...item, responders: ['wrong'], published: 2 } : item)
  const result = compareGroupPolicies(fixture.cases, baseline, wrong)
  assert.ok(result.blocked.includes('responder_regression')); assert.ok(result.blocked.includes('noise_regression'))
  assert.throws(() => evaluateGroupDecisions(fixture.cases, [...baseline, baseline[0]]), /case_ids/)
  assert.throws(() => evaluateGroupDecisions(fixture.cases, [{ ...baseline[0], wakes: -1 }]), /observation/)
  assert.throws(() => evaluateGroupDecisions(fixture.cases, [{ ...baseline[0], costUsd: Number.NaN }]), /observation/)
})

test('runtime observations count actual events, including no public message for delegated work', () => {
  const trace = createGroupDecisionTrace([], [])
  trace.action = 'delegate'; trace.status = 'complete'; trace.responders = ['worker']
  trace.events = [{ id: 'delegate', type: 'delegate', taskId: 'task', outcome: 'succeeded' }, { id: 'result', type: 'task_result', outcome: 'succeeded' }]
  const observation = groupTraceObservation('silent-delegation', trace, null)
  assert.equal(observation.wakes, 0); assert.equal(observation.generations, 0); assert.equal(observation.published, 0)
  assert.equal(observation.delegated, 1); assert.equal(observation.delegationCompleted, true)
  trace.startedAt='2026-11-03T00:00:00.000Z';trace.finishedAt='2026-11-03T00:00:01.000Z'
  assert.equal(groupTraceObservation('silent-delegation',trace,null).endToEndLatencyMs,null,'intake completion is not task completion')
  trace.taskFinishedAt='2026-11-03T00:01:00.000Z'
  assert.equal(groupTraceObservation('silent-delegation',trace,null).endToEndLatencyMs,60_000)
})

test('feedback provenance cannot be client-selected and policy rollback is explicit/versioned', () => {
  const input = { messageId: '00000000-0000-4000-8000-000000000001', kind: 'reaction_positive' }
  assert.equal(groupFeedbackInput.safeParse(input).success, true)
  assert.equal(groupFeedbackInput.safeParse({ ...input, source: 'agent_evaluation' }).success, false)
  assert.equal(groupFeedbackInput.safeParse({ ...input, policyVersion: 'new' }).success, false)
  assert.equal(getGroupDecisionPolicy(GROUP_BASELINE_VERSION).version, GROUP_BASELINE_VERSION)
  assert.equal(getGroupDecisionPolicy(GROUP_POLICY_VERSION).version, GROUP_POLICY_VERSION)
  assert.throws(() => getGroupDecisionPolicy('unknown'), /unknown_group_decision_policy/)
})

test('v2 is the current replay candidate while historical v1 receipts keep their original version', () => {
  const receipt = { executionId: 'execution', modelId: DECISION_MODEL as typeof DECISION_MODEL, providerGenerationId: 'provider', startedAt: '2026-11-03T00:00:00Z', completedAt: '2026-11-03T00:00:01Z', requestDigest: 'a'.repeat(64), imageDigests: [], vision: 'no-image-input' as const }
  const versions = [GROUP_BASELINE_VERSION, GROUP_PREVIOUS_POLICY_VERSION, GROUP_POLICY_VERSION]
  const steps = versions.map((policyVersion,index)=>({id:`version-${index}`,phase:'responder' as const,index:0,status:'complete' as const,failure:null,receipt,policyVersion}))
  assert.deepEqual(groupDecisionSteps(steps).map(step=>step.policyVersion),versions)
  const unknown = {...steps[0],policyVersion:'group-contribution-unknown'} as unknown as GroupDecisionStep
  assert.equal(groupDecisionSteps([unknown])[0].policyVersion,undefined)
  assert.equal(getGroupDecisionPolicy(GROUP_PREVIOUS_POLICY_VERSION).version,GROUP_PREVIOUS_POLICY_VERSION)
  for(const policyVersion of [GROUP_BASELINE_VERSION,GROUP_POLICY_VERSION]){
    assert.equal(groupDecisionReplayInput.safeParse({caseId:'small-talk',policyVersion}).success,true)
  }
  assert.equal(groupDecisionReplayInput.safeParse({caseId:'small-talk',policyVersion:GROUP_PREVIOUS_POLICY_VERSION}).success,false)
})
