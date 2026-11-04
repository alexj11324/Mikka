import assert from 'node:assert/strict'
import test from 'node:test'
import { assertAutomaticRecoverySource, assertHandoffConfiguration, assertHandoffEvidence, beginAutomaticHandoff } from './factory-handoff-acceptance.mjs'

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
  const original = { id: 'old', userId: 'owner', issueId: 'issue', deviceId: 'A', agentDefinition: { harness: 'claude_code', model: 'deepseek-flash',
    repositoryAdmission: { authority: 'owner_credential', deviceId: 'A', requestEventId: null }, executionIdentity: identity } }
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
    value => { value.original.agentDefinition.pinnedDeviceId = 'A' },
    value => { value.original.agentDefinition.repositoryAdmission.requestEventId = 'explicit-destination-event' },
    value => { value.retry.deviceId = 'A' },
    value => { value.retry.agentDefinition.executionIdentity.outputOwner = 'peer' },
    value => { value.retry.agentDefinition.executionIdentity.billingAccount.model.ownerId = 'peer' },
    value => { value.receipt.result.requestEpoch = 'epoch1' },
    value => { value.receipt.result.checkpoint.unavailableReason = 'too_large' },
    value => { value.retry.prompt = 'Please continue' },
  ]) { const value = fixture(); mutate(value); assert.throws(() => assertHandoffEvidence(value)) }
})

test('the automatic recovery workload starts on A before B is approved or started, for both scenarios', async () => {
  for (const name of ['item9', 'item10']) {
    const calls = []
    const original = { ...fixture().original, status: 'running', sessionId: 'native-A', startedAt: new Date().toISOString() }
    const result = await beginAutomaticHandoff({ name, brief: 'Create the acceptance artifact.', deviceId: 'A',
      devices: async () => { calls.push('devices'); return [{ id: 'A', online: true }, { id: 'B', online: false }] },
      dispatch: async (label, text) => { calls.push('dispatch'); assert.equal(label, name); assert.match(text, /automatic device placement/); assert.doesNotMatch(text, /deviceId|on device A/); return original.id },
      run: async () => { calls.push('read-A'); return original },
      until: async predicate => { const value = await predicate(); assert.ok(value); return value },
      startSecondDaemon: async () => { calls.push('start-B'); assert.equal(calls.at(-2), 'read-A'); return { dataDir: '/owned/B', pid: 42 } },
      online: async () => { calls.push('B-ready'); return { server: 'online', signedIn: true, deviceId: 'B', dataDir: '/owned/B' } },
    })
    assert.equal(result.original, original)
    assert.equal(result.bStatus.deviceId, 'B')
    assert.deepEqual(calls, ['devices', 'dispatch', 'read-A', 'read-A', 'start-B', 'B-ready'])
  }
})

test('an explicit pin, host destination event, another initial device or unauthorized B cannot become handoff evidence', async () => {
  for (const mutate of [
    value => { value.agentDefinition.pinnedDeviceId = 'A' },
    value => { value.agentDefinition.repositoryAdmission.requestEventId = 'explicit' },
    value => { value.deviceId = 'B' },
    value => { value.agentDefinition.repositoryAdmission.authority = 'invented' },
  ]) {
    const original = fixture().original
    mutate(original)
    assert.throws(() => assertAutomaticRecoverySource(original, 'A'))
    let startedB = false
    await assert.rejects(beginAutomaticHandoff({ name: 'item9', brief: 'fixture', deviceId: 'A',
      devices: async () => [{ id: 'A', online: true }], dispatch: async () => original.id, run: async () => original,
      until: predicate => predicate(), startSecondDaemon: async () => { startedB = true }, online: async () => {},
    }))
    assert.equal(startedB, false, 'refuse before creating B or injecting any fault')
  }
})

test('a still-online B from the previous scenario prevents a second automatic dispatch', async () => {
  let paid = false, clock = 0
  await assert.rejects(beginAutomaticHandoff({ name: 'item10', brief: 'fixture', deviceId: 'A', now: () => clock,
    devices: async () => [{ id: 'A', online: true }, { id: 'B', online: true }],
    until: async predicate => { assert.equal(await predicate(), false); clock = 120_001; return predicate() },
    dispatch: async () => { paid = true },
  }), /Only the initial owned device/)
  assert.equal(paid, false)
})

test('uncertain effects, in-flight publications and executing operations cannot count as safe recovery', () => {
  for (const [name, status] of [['effects', 'reserved'], ['effects', 'uncertain'], ['publications', 'processing'], ['operations', 'executing'], ['operations', 'uncertain']]) {
    const value = fixture(); value.receipt.result.externalEffects[name].push({ status })
    assert.throws(() => assertHandoffEvidence(value))
  }
})
