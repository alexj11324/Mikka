import assert from 'node:assert/strict'
import test from 'node:test'
import { botModelChoice, defaultModel, groupBotModels, harnessOptions, initialExecution, modelName, modelOptions, modelProvider, placeKind, redetectTargets, retarget, selectedBotModel, type ExecutionPlace } from './execution-settings-view'

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

test('harnesses are the installed ones at a device; cloud offers every rule harness', () => {
  assert.deepEqual(harnessOptions(places, laptop.id), ['claude_code', 'codex'])
  assert.deepEqual(harnessOptions(places, server.id), ['codex'])
  assert.deepEqual(harnessOptions(places, 'cloud'), ['claude_code', 'codex', 'cursor'])
})

const names = (options: { name: string }[]) => options.map(option => option.name)

test('models are only what the harness reported there, never a built-in list', () => {
  assert.deepEqual(names(modelOptions(places, laptop.id, 'codex')), ['reported-a', 'reported-b'])
  assert.deepEqual(names(modelOptions(places, laptop.id, 'cursor')), [])
  assert.deepEqual(names(modelOptions(places, 'cloud', 'codex')), ['reported-a', 'reported-b', 'reported-c'])
  // #537 shim: Claude Code reports nothing yet, so only its `opus` slot is offered.
  assert.deepEqual(modelOptions(places, laptop.id, 'claude_code'), [{ value: 'opus', name: 'opus' }])
})

const slotted = (id: string, deviceType: 'laptop' | 'server', online: boolean, opus: string): ExecutionPlace => ({
  id, name: id, deviceType, enabled: true, online,
  harnesses: [
    { harness: 'claude_code', installed: true, version: '1', modelSlots: [{ slot: 'sonnet', model: 'Sonnet X', name: 'Sonnet X' }, { slot: 'opus', model: opus, name: opus }] },
    { harness: 'codex', installed: true, version: '1', modelSlots: [{ slot: 'mini', model: 'Mini Y', name: 'Mini Y' }, { slot: 'main', model: 'Codex Default Z', name: 'Codex Default Z' }], defaultModelSlot: 'main' },
  ],
})

test('a reported slot is stored, and only the model it resolves to is shown', () => {
  const mac = slotted('mac', 'laptop', true, 'DS 4.1 Flash')
  const options = modelOptions([mac], 'mac', 'claude_code')
  assert.deepEqual(options.map(option => option.value), ['sonnet', 'opus'])
  assert.equal(defaultModel(options, 'claude_code')?.value, 'opus')
  assert.equal(modelName([mac], 'mac', 'claude_code', 'opus'), 'DS 4.1 Flash')
  assert.equal(defaultModel(modelOptions([mac], 'mac', 'codex'), 'codex')?.name, 'Codex Default Z')
  assert.equal(modelName([mac], 'mac', 'codex', 'gone-model'), 'gone-model')
})

const claude = { provider: 'claude', modelId: 'claude-account-model' }
const codex = { provider: 'codex', modelId: 'codex-account-model' }

test('initial value: a Claude subscription runs Claude Code on the server first, on its opus slot', () => {
  const mac = slotted('mac', 'laptop', true, 'Opus Resolved')
  const box = slotted('box', 'server', true, 'Opus On Box')
  assert.deepEqual(initialExecution([mac, box, cloud], [codex, claude]), { place: 'box', harness: 'claude_code', model: 'opus' })
  assert.equal(modelName([mac, box], 'box', 'claude_code', 'opus'), 'Opus On Box')
})

test('initial value: an offline server is skipped for any online device, then the cloud', () => {
  const mac = slotted('mac', 'laptop', true, 'Opus Resolved')
  const box = slotted('box', 'server', false, 'Opus On Box')
  assert.deepEqual(initialExecution([box, mac, cloud], [claude]), { place: 'mac', harness: 'claude_code', model: 'opus' })
  assert.deepEqual(initialExecution([box, cloud], [claude]), { place: 'cloud', harness: 'claude_code', model: 'opus' })
  assert.deepEqual(initialExecution([{ ...mac, enabled: false }, cloud], [claude]).place, 'cloud')
})

test('initial value: without Claude, a ChatGPT/Codex subscription runs Codex on its default model', () => {
  const mac = slotted('mac', 'laptop', true, 'Opus Resolved')
  assert.deepEqual(initialExecution([mac, cloud], [codex]), { place: 'mac', harness: 'codex', model: 'main' })
  // #537 shim: a daemon that marks no default slot falls back to the first model it reports.
  assert.deepEqual(initialExecution([laptop, cloud], [codex]), { place: laptop.id, harness: 'codex', model: 'reported-a' })
  // No device reports Codex models: the account's own model.
  assert.deepEqual(initialExecution([cloud], [codex]), { place: 'cloud', harness: 'codex', model: 'codex-account-model' })
})

test('initial value: with no subscription, the first online device and a harness installed there', () => {
  assert.deepEqual(initialExecution([server, laptop, cloud], []), { place: laptop.id, harness: 'claude_code', model: 'opus' })
  assert.deepEqual(initialExecution([{ ...server, online: true }, cloud], []), { place: server.id, harness: 'codex', model: 'reported-b' })
})

test('re-detection asks the chosen device, and every local device for cloud', () => {
  assert.deepEqual(redetectTargets(places, server.id), [server.id])
  assert.deepEqual(redetectTargets(places, 'cloud'), [laptop.id, server.id, old.id])
  assert.deepEqual(redetectTargets(places, 'missing'), [])
})

test('moving a rule keeps the harness and model only where the new place has them, else the defaults there', () => {
  const rule = { label: 'backend', place: server.id, harness: 'codex', model: 'reported-c' }
  assert.deepEqual(retarget(places, { ...rule, place: laptop.id }), { ...rule, place: laptop.id, model: 'reported-a' })
  assert.deepEqual(retarget(places, { ...rule, harness: 'claude_code', model: 'opus' }), { ...rule, harness: 'codex', model: 'reported-b' })
  assert.deepEqual(retarget(places, { ...rule, place: 'cloud' }), { ...rule, place: 'cloud' })
  assert.deepEqual(retarget(places, { ...rule, place: laptop.id, harness: 'claude_code' }), { ...rule, place: laptop.id, harness: 'claude_code', model: 'opus' })
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

test('a Bot with no saved model shows the Claude account first, then ChatGPT', () => {
  const rows = [
    { bindingId: 'b3', consumerId: 'bot-a', modelId: 'm2', route: 'codex_cpa', connectionId: 'c2', provider: 'codex' },
    { bindingId: 'b1', consumerId: 'bot-a', modelId: 'm1', route: 'claude_cpa', connectionId: 'c1', provider: 'claude' },
  ]
  assert.equal(botModelChoice(rows, null)?.modelId, 'm1')
  assert.equal(botModelChoice(rows, 'b3')?.modelId, 'm2')
  assert.equal(botModelChoice(rows.slice(0, 1), null)?.modelId, 'm2')
  assert.equal(botModelChoice([], null), null)
})
