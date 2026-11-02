import assert from 'node:assert/strict'
import test from 'node:test'
import { botModelChoice, defaultModel, groupBotModels, harnessOptions, initialExecution, modelName, modelOptions, modelProvider, modelUnavailable, placeKind, redetectTargets, retarget, selectedBotModel, withCloudModels, type ExecutionPlace } from './execution-settings-view'

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

const accounts = [{ provider: 'claude', modelId: 'claude-e2e' }, { provider: 'codex', modelId: 'codex-a' }, { provider: 'codex', modelId: 'codex-b' }]

test('harnesses are the installed ones at a device; Mikka Cloud offers the connected accounts\' Agents', () => {
  assert.deepEqual(harnessOptions(places, laptop.id), ['claude_code', 'codex'])
  assert.deepEqual(harnessOptions(places, server.id), ['codex'])
  assert.deepEqual(harnessOptions(withCloudModels(places, accounts), 'cloud'), ['claude_code', 'codex'])
  assert.deepEqual(harnessOptions(withCloudModels(places, accounts.slice(1)), 'cloud'), ['codex'])
  assert.deepEqual(harnessOptions(withCloudModels(places, []), 'cloud'), [])
})

const names = (options: { name: string }[]) => options.map(option => option.name)

test('models are only what the harness reported there, never a built-in list', () => {
  assert.deepEqual(names(modelOptions(places, laptop.id, 'codex')), ['reported-a', 'reported-b'])
  assert.deepEqual(names(modelOptions(places, laptop.id, 'cursor')), [])
  // Mikka Cloud runs on the account: its models, never a device's slots, as the server checks.
  assert.deepEqual(names(modelOptions(withCloudModels(places, accounts), 'cloud', 'codex')), ['codex-a', 'codex-b'])
  assert.deepEqual(names(modelOptions(withCloudModels(places, accounts), 'cloud', 'claude_code')), ['claude-e2e'])
  // Claude Code reported nothing: nothing is offered, no slot name stands in (Alex, 2026-11-02).
  assert.deepEqual(modelOptions(places, laptop.id, 'claude_code'), [])
})

test('an API key\'s models are offered under the Agent its protocol needs, on Mikka Cloud and on devices where that Agent is installed', () => {
  const keys = [{ harness: 'claude_code' as const, models: ['key-a', 'key-b'] }, { harness: 'codex' as const, models: ['reported-b', 'key-c'] }]
  const withKeys = withCloudModels(places, accounts.slice(1), keys)
  assert.deepEqual(harnessOptions(withKeys, 'cloud'), ['claude_code', 'codex'], 'a key alone gives Mikka Cloud its Agent')
  assert.deepEqual(names(modelOptions(withKeys, 'cloud', 'claude_code')), ['key-a', 'key-b'])
  assert.deepEqual(names(modelOptions(withKeys, 'cloud', 'codex')), ['codex-a', 'codex-b', 'reported-b', 'key-c'])
  // Claude Code reported nothing on the laptop; the key's models are offered there, once each, after what the CLI reported.
  assert.deepEqual(names(modelOptions(withKeys, laptop.id, 'claude_code')), ['key-a', 'key-b'])
  assert.deepEqual(names(modelOptions(withKeys, laptop.id, 'codex')), ['reported-a', 'reported-b', 'key-c'])
  assert.deepEqual(names(modelOptions(withKeys, laptop.id, 'cursor')), [], 'never on an Agent that is not installed')
  // A key's model is marked as one: its mark is its own name's provider, never the Agent's (R-74).
  assert.deepEqual(modelOptions(withKeys, laptop.id, 'codex').map(option => [option.value, Boolean(option.apiKey)]), [['reported-a', false], ['reported-b', false], ['key-c', true]])
  assert.deepEqual(modelOptions(withKeys, 'cloud', 'codex').filter(option => option.apiKey).map(option => option.value), ['reported-b', 'key-c'])
  // A device reporting slots keeps them, with the key's models after them.
  const mac = withCloudModels([slotted('mac', 'laptop', true, 'Opus Z')], [], keys)
  assert.deepEqual(modelOptions(mac, 'mac', 'claude_code').map(option => [option.value, option.name]), [['sonnet', 'Sonnet X'], ['opus', 'Opus Z'], ['key-a', 'key-a'], ['key-b', 'key-b']])
})

const slotted = (id: string, deviceType: 'laptop' | 'server', online: boolean, resolved: string, claudeDefault?: string): ExecutionPlace => ({
  id, name: id, deviceType, enabled: true, online,
  harnesses: [
    { harness: 'claude_code', installed: true, version: '1', modelSlots: [{ slot: 'sonnet', model: 'Sonnet X', name: 'Sonnet X' }, { slot: 'opus', model: resolved, name: resolved }], ...(claudeDefault ? { defaultModelSlot: claudeDefault } : {}) },
    { harness: 'codex', installed: true, version: '1', modelSlots: [{ slot: 'mini', model: 'Mini Y', name: 'Mini Y' }, { slot: 'main', model: 'Codex Default Z', name: 'Codex Default Z' }], defaultModelSlot: 'main' },
  ],
})

test('a reported slot is stored, only the model it resolves to is shown, and the default is the one the CLI marks', () => {
  const mac = slotted('mac', 'laptop', true, 'DS 4.1 Flash')
  const options = modelOptions([mac], 'mac', 'claude_code')
  assert.deepEqual(options.map(option => option.value), ['sonnet', 'opus'])
  assert.equal(defaultModel(options), undefined, 'no slot marked default: none is picked by its name')
  assert.equal(defaultModel(modelOptions([slotted('mac', 'laptop', true, 'DS 4.1 Flash', 'sonnet')], 'mac', 'claude_code'))?.value, 'sonnet')
  assert.equal(modelName([mac], 'mac', 'claude_code', 'opus'), 'DS 4.1 Flash')
  assert.equal(defaultModel(modelOptions([mac], 'mac', 'codex'))?.name, 'Codex Default Z')
  // A plain reported model list marks its default by id too.
  assert.equal(defaultModel(modelOptions([{ ...laptop, harnesses: [{ harness: 'codex', installed: true, version: '1', models: ['reported-a', 'reported-b'], defaultModelSlot: 'reported-b' }] }], laptop.id, 'codex'))?.value, 'reported-b')
  assert.equal(modelName([mac], 'mac', 'codex', 'gone-model'), 'gone-model')
})

test('a saved model the place no longer reports is unavailable, never an option', () => {
  const mac = slotted('mac', 'laptop', true, 'DS 4.1 Flash')
  assert.equal(modelUnavailable([mac], 'mac', 'codex', 'main'), false)
  assert.equal(modelUnavailable([mac], 'mac', 'codex', 'opus'), true, 'a Claude slot saved on Codex is unavailable there')
  assert.equal(modelUnavailable(places, laptop.id, 'claude_code', 'opus'), true, 'Claude Code reported nothing')
  assert.equal(modelUnavailable(places, laptop.id, 'codex', ''), false, 'no model is not an unavailable one')
  assert.ok(!modelOptions(places, laptop.id, 'claude_code').some(option => option.value === 'opus'))
})

const claude = { provider: 'claude', modelId: 'claude-account-model' }
const codex = { provider: 'codex', modelId: 'codex-account-model' }

test('initial value: a Claude subscription runs Claude Code on the server first, on the model its CLI marks default', () => {
  const mac = slotted('mac', 'laptop', true, 'Opus Resolved')
  const box = slotted('box', 'server', true, 'Opus On Box')
  assert.deepEqual(initialExecution([mac, box, cloud], [codex, claude]), { place: 'box', harness: 'claude_code', model: '' }, 'no default marked: the person picks')
  assert.deepEqual(initialExecution([mac, slotted('box', 'server', true, 'Opus On Box', 'sonnet'), cloud], [codex, claude]), { place: 'box', harness: 'claude_code', model: 'sonnet' })
})

test('initial value: an offline server is skipped for any online device, then the cloud', () => {
  const mac = slotted('mac', 'laptop', true, 'Opus Resolved', 'opus')
  const box = slotted('box', 'server', false, 'Opus On Box', 'opus')
  assert.deepEqual(initialExecution([box, mac, cloud], [claude]), { place: 'mac', harness: 'claude_code', model: 'opus' })
  // On Mikka Cloud the account lists models but marks none default: the person picks one.
  assert.deepEqual(initialExecution([box, cloud], [claude]), { place: 'cloud', harness: 'claude_code', model: '' })
  assert.deepEqual(initialExecution(withCloudModels([box, cloud], [claude]), [claude]), { place: 'cloud', harness: 'claude_code', model: '' })
  assert.deepEqual(initialExecution([{ ...mac, enabled: false }, cloud], [claude]).place, 'cloud')
})

test('initial value: without Claude, a ChatGPT/Codex subscription runs Codex on its default model', () => {
  const mac = slotted('mac', 'laptop', true, 'Opus Resolved')
  assert.deepEqual(initialExecution([mac, cloud], [codex]), { place: 'mac', harness: 'codex', model: 'main' })
  // A daemon that marks no default: no model is guessed from the list.
  assert.deepEqual(initialExecution([laptop, cloud], [codex]), { place: laptop.id, harness: 'codex', model: '' })
  assert.deepEqual(initialExecution([cloud], [codex]), { place: 'cloud', harness: 'codex', model: '' })
})

test('initial value: with no subscription, the first online device and a harness installed there', () => {
  assert.deepEqual(initialExecution([server, laptop, cloud], []), { place: laptop.id, harness: 'claude_code', model: '' })
  assert.deepEqual(initialExecution([{ ...server, online: true }, cloud], []), { place: server.id, harness: 'codex', model: '' })
})

test('re-detection asks the chosen device, and every local device for cloud', () => {
  assert.deepEqual(redetectTargets(places, server.id), [server.id])
  assert.deepEqual(redetectTargets(places, 'cloud'), [laptop.id, server.id, old.id])
  assert.deepEqual(redetectTargets(places, 'missing'), [])
})

test('moving a rule keeps the harness and model only where the new place has them; an old model never carries over', () => {
  const rule = { label: 'backend', place: server.id, harness: 'codex', model: 'reported-c' }
  assert.deepEqual(retarget(places, { ...rule, place: laptop.id, model: 'reported-b' }), { ...rule, place: laptop.id, model: 'reported-b' }, 'still reported there: kept')
  assert.deepEqual(retarget(places, { ...rule, place: laptop.id }), { ...rule, place: laptop.id, model: '' }, 'not reported there and no default: cleared')
  assert.deepEqual(retarget(places, { ...rule, harness: 'claude_code', model: 'opus' }), { ...rule, harness: 'codex', model: '' })
  assert.deepEqual(retarget(withCloudModels(places, accounts), { ...rule, place: 'cloud' }), { ...rule, place: 'cloud', model: '' })
  assert.deepEqual(retarget(withCloudModels(places, accounts), { ...rule, place: 'cloud', model: 'codex-b' }), { ...rule, place: 'cloud', model: 'codex-b' })
  assert.deepEqual(retarget(withCloudModels(places, accounts), { ...rule, place: 'cloud', harness: 'claude_code', model: 'opus' }), { ...rule, place: 'cloud', harness: 'claude_code', model: '' })
  // Switching the Agent: Codex reports nothing here, so the Claude model it had is cleared, not shown on Codex.
  const quiet: ExecutionPlace = { ...laptop, harnesses: [{ harness: 'claude_code', installed: true, version: '1', models: ['claude-x'] }, { harness: 'codex', installed: true, version: '1' }] }
  assert.deepEqual(retarget([quiet], { place: quiet.id, harness: 'codex', model: 'claude-x' }), { place: quiet.id, harness: 'codex', model: '' })
  // To a harness whose CLI marks a default: that default.
  const mac = slotted('mac', 'laptop', true, 'Opus Resolved')
  assert.deepEqual(retarget([mac], { place: 'mac', harness: 'codex', model: 'sonnet' }), { place: 'mac', harness: 'codex', model: 'main' })
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
