import assert from 'node:assert/strict'
import test from 'node:test'
import { groupBotModels, harnessOptions, modelOptions, modelProvider, placeKind, redetectTargets, retarget, selectedBotModel, type ExecutionPlace } from './execution-settings-view'

const laptop: ExecutionPlace = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Alex MacBook Pro', deviceType: 'laptop', enabled: true, online: true,
  harnesses: [
    { harness: 'claude_code', installed: true, version: '1' },
    { harness: 'codex', installed: true, version: '1', models: ['reported-a', 'reported-b'] },
    { harness: 'cursor', installed: false, version: null, models: ['not-installed'] },
  ],
}
const server: ExecutionPlace = {
  id: '00000000-0000-4000-8000-000000000002', name: 'build-01', deviceType: 'server', enabled: true, online: false,
  harnesses: [{ harness: 'codex', installed: true, version: '1', models: ['reported-b', 'reported-c'] }],
}
const old: ExecutionPlace = { id: '00000000-0000-4000-8000-000000000003', name: 'old', deviceType: null, online: true, harnesses: [] }
const cloud: ExecutionPlace = { id: 'cloud', kind: 'cloud', deviceType: 'server', online: true, harnesses: [] }
const places = [laptop, server, old, cloud]

test('device type comes from the daemon; cloud wins over its server type; old daemons stay unknown', () => {
  assert.deepEqual(places.map(placeKind), ['laptop', 'server', 'unknown', 'cloud'])
})

test('harnesses are the installed ones at a device; auto and cloud offer every rule harness', () => {
  assert.deepEqual(harnessOptions(places, laptop.id), ['claude_code', 'codex'])
  assert.deepEqual(harnessOptions(places, server.id), ['codex'])
  assert.deepEqual(harnessOptions(places, 'auto'), ['claude_code', 'codex', 'cursor'])
  assert.deepEqual(harnessOptions(places, 'cloud'), ['claude_code', 'codex', 'cursor'])
})

test('models are only what the harness reported there, never a built-in list', () => {
  assert.deepEqual(modelOptions(places, laptop.id, 'codex'), ['reported-a', 'reported-b'])
  assert.deepEqual(modelOptions(places, laptop.id, 'claude_code'), [])
  assert.deepEqual(modelOptions(places, laptop.id, 'cursor'), [])
  assert.deepEqual(modelOptions(places, laptop.id, 'auto'), [])
  assert.deepEqual(modelOptions(places, 'cloud', 'codex'), [])
  assert.deepEqual(modelOptions(places, 'auto', 'codex'), ['reported-a', 'reported-b', 'reported-c'])
})

test('re-detection asks the chosen device, every local device for auto, and nothing for cloud', () => {
  assert.deepEqual(redetectTargets(places, server.id), [server.id])
  assert.deepEqual(redetectTargets(places, 'auto'), [laptop.id, server.id, old.id])
  assert.deepEqual(redetectTargets(places, 'cloud'), [])
  assert.deepEqual(redetectTargets(places, 'missing'), [])
})

test('moving a rule keeps the harness and model only where the new place has them', () => {
  const rule = { label: 'backend', place: server.id, harness: 'codex', model: 'reported-c' }
  assert.deepEqual(retarget(places, { ...rule, place: laptop.id }), { ...rule, place: laptop.id, model: 'auto' })
  assert.deepEqual(retarget(places, { ...rule, harness: 'claude_code', model: 'auto', place: server.id }), { ...rule, harness: 'auto', model: 'auto' })
  assert.deepEqual(retarget(places, { ...rule, place: 'cloud' }), { ...rule, place: 'cloud', model: 'auto' })
})

test('the provider mark follows the model id, then the account or harness', () => {
  assert.equal(modelProvider('claude-opus-4-5'), 'claude')
  assert.equal(modelProvider('sonnet'), 'claude')
  assert.equal(modelProvider('gpt-5'), 'openai')
  assert.equal(modelProvider('o3'), 'openai')
  assert.equal(modelProvider('dynamic-model', 'codex'), 'openai')
  assert.equal(modelProvider('dynamic-model', 'claude'), 'claude')
  assert.equal(modelProvider('dynamic-model', 'claude_code'), 'claude')
  assert.equal(modelProvider('composer-1', 'cursor'), 'unknown')
})

test('bot models group by account and list a copied binding once', () => {
  const rows = [
    { bindingId: 'b1', consumerId: 'bot-a', modelId: 'm1', route: 'claude_cpa', connectionId: 'c1', provider: 'claude' },
    { bindingId: 'b2', consumerId: 'bot-b', modelId: 'm1', route: 'claude_cpa', connectionId: 'c1', provider: 'claude' },
    { bindingId: 'b3', consumerId: 'bot-a', modelId: 'm2', route: 'codex_cpa', connectionId: 'c2', provider: 'codex' },
  ]
  const accounts = groupBotModels(rows)
  assert.deepEqual(accounts.map(account => [account.connectionId, account.models.map(model => model.bindingId)]), [['c1', ['b1']], ['c2', ['b3']]])
  assert.equal(selectedBotModel(rows, 'b2')?.key, accounts[0].models[0].key)
  assert.equal(selectedBotModel(rows, null), null)
  assert.equal(selectedBotModel(rows, 'gone'), null)
})
