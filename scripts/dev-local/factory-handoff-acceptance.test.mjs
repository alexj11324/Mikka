import assert from 'node:assert/strict'
import test from 'node:test'
import { assertHandoffConfiguration, assertHandoffEvidence } from './factory-handoff-acceptance.mjs'

test('fault injection requires a fresh owned Linux stack and the reviewed immutable source pin', () => {
  const config = { existing: false, platform: 'linux', revision: 'a'.repeat(40), expectedSource: 'a'.repeat(40) }
  assertHandoffConfiguration(config)
  for (const change of [{ existing: true }, { platform: 'darwin' }, { revision: 'main', expectedSource: 'main' }, { expectedSource: undefined }, { expectedSource: 'b'.repeat(40) }]) {
    assert.throws(() => assertHandoffConfiguration({ ...config, ...change }))
  }
})

function fixture() {
  const identity = { requester: 'owner', executionPrincipal: 'owner', outputOwner: 'owner', workspaceId: null,
    botId: null, botOwner: null, personalResourcePolicy: 'requester_only',
    resourceBindings: [{ kind: 'device', id: 'A', ownerId: 'owner' }],
    billingAccount: { model: { kind: 'api_key', ownerId: 'owner', resourceId: 'key' }, runtime: { kind: 'local_device', ownerId: 'owner', resourceId: 'A' } } }
  const original = { id: 'old', userId: 'owner', issueId: 'issue', deviceId: 'A', agentDefinition: { executionIdentity: identity } }
  const rebound = structuredClone(identity)
  rebound.resourceBindings[0].id = 'B'; rebound.billingAccount.runtime.resourceId = 'B'
  const digest = 'a'.repeat(64)
  return { original, ownerId: 'owner', deviceB: 'B', marker: 'owner-target', task: { id: 'task', sourceEventId: 'epoch2' },
    retry: { id: 'retry', retryOf: 'old', userId: 'owner', issueId: 'issue', deviceId: 'B', startedAt: new Date(), sessionId: 'native-B',
      prompt: `Host task handoff ${digest}`, agentDefinition: { model: 'deepseek-flash', executionIdentity: rebound } },
    receipt: { request: { kind: 'task_handoff', digest }, result: { taskId: 'task', requestEpoch: 'epoch2', ownerId: 'owner',
      goal: { sourceEventId: 'epoch2', text: 'owner-target' }, checkpoint: { runId: 'old', files: 1 }, completed: [], pending: { stage: 'execute' },
      constraints: { instruction: 'Keep existing permissions' }, nextAction: 'Resume', risks: ['Check receipts'], externalEffects: { effects: [], publications: [], operations: [] } } } }
}

test('actual same-owner B claim, frozen model payer and current-epoch structured handoff are required', () => {
  assert.equal(assertHandoffEvidence(fixture()).requestEpoch, 'epoch2')
  for (const mutate of [
    value => { value.retry.startedAt = null },
    value => { value.retry.deviceId = 'A' },
    value => { value.retry.agentDefinition.executionIdentity.outputOwner = 'peer' },
    value => { value.retry.agentDefinition.executionIdentity.billingAccount.model.ownerId = 'peer' },
    value => { value.receipt.result.requestEpoch = 'epoch1' },
    value => { value.receipt.result.checkpoint.unavailableReason = 'too_large' },
    value => { value.retry.prompt = 'Please continue' },
  ]) { const value = fixture(); mutate(value); assert.throws(() => assertHandoffEvidence(value)) }
})

test('uncertain effects, in-flight publications and executing operations cannot count as safe recovery', () => {
  for (const [name, status] of [['effects', 'reserved'], ['effects', 'uncertain'], ['publications', 'processing'], ['operations', 'executing'], ['operations', 'uncertain']]) {
    const value = fixture(); value.receipt.result.externalEffects[name].push({ status })
    assert.throws(() => assertHandoffEvidence(value))
  }
})
