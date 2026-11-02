import assert from 'node:assert/strict'
import test from 'node:test'
import { agentsByOffer, defaultOrder, deviceModel, onPreferredAgent, pickDevice, planDispatch, whyNoDevice, type CredentialState, type OrderEntry, type PoolDevice } from './model-order-plan'

// Model names here are fixtures standing for what a CLI or provider reported.
const sub = (id: string, harness: OrderEntry['harness'], model: string, connectionId = `conn-${harness}`): OrderEntry => ({ id, harness, model, source: { kind: 'subscription', connectionId } })
const key = (id: string, harness: OrderEntry['harness'], model: string): OrderEntry => ({ id, harness, model, source: { kind: 'api_key', keyId: 'key-1' } })
const device = (id: string, over: Partial<PoolDevice> = {}): PoolDevice => ({
  id, name: id, online: true, enabled: true, server: false, activeRuns: 0, joinedAt: 0,
  harnesses: [
    { harness: 'claude_code', installed: true, subscriptionBroker: true, modelSlots: [{ slot: 'top', model: 'reported-claude-top', name: 'Top' }] },
    { harness: 'codex', installed: true, subscriptionBroker: true, models: ['reported-codex-a'] },
  ],
  ...over,
})
const usable = (): CredentialState => ({ usable: true })
const first = sub('1', 'claude_code', 'reported-claude-top')
const second = sub('2', 'codex', 'reported-codex-a')
const keyed = key('3', 'claude_code', 'key-model')

test('an allowance check that failed keeps the subscription preference and does not silently charge a key', () => {
  const plan = planDispatch({ entries: [first, keyed], location: 'local', devices: [device('mac')], credential: entry => entry.id === first.id ? { usable: false, reason: 'checking' } : usable(), cloudReady: false })
  assert.equal(plan.kind, 'none')
  assert.equal(plan.kind === 'none' && plan.reason, 'checking')
  assert.deepEqual(plan.skipped.map(item => item.block.reason), ['checking'])
})

test('the first allowed model that can run takes the run; the full provider model is what runs despite a CLI slot', () => {
  const plan = planDispatch({ entries: [first, second], location: 'local', devices: [device('mac')], credential: usable, cloudReady: false })
  assert.deepEqual([plan.kind, plan.kind === 'device' && plan.entry.id, plan.kind === 'device' && plan.model], ['device', '1', 'reported-claude-top'])
})

test('ordered fallback: quota used up, signed out, or no device moves to the next model, and says why each was skipped', () => {
  const credential = (entry: OrderEntry): CredentialState => entry.id === '1' ? { usable: false, reason: 'quota', resetsAt: '2026-11-02T14:20:00Z' } : usable()
  const plan = planDispatch({ entries: [first, second], location: 'local', devices: [device('mac')], credential, cloudReady: false })
  assert.equal(plan.kind === 'device' && plan.entry.id, '2')
  assert.deepEqual(plan.skipped.map(item => [item.entry.id, item.block.reason]), [['1', 'quota']])
  const noClaude = planDispatch({ entries: [first, second], location: 'local', devices: [device('box', { harnesses: [{ harness: 'codex', installed: true, subscriptionBroker: true, models: ['reported-codex-a'] }] })], credential: usable, cloudReady: false })
  assert.deepEqual([noClaude.kind === 'device' && noClaude.entry.id, noClaude.skipped.map(item => item.block.reason)], ['2', ['noDevice']])
  const expired = planDispatch({ entries: [first, second], location: 'local', devices: [device('mac')], credential: entry => entry.id === '2' ? usable() : { usable: false, reason: 'expired' }, cloudReady: false })
  assert.equal(expired.kind === 'device' && expired.entry.id, '2')
})

test('本地 picks only among the devices that can run it, never one with 参与调度 off, offline, or unable to take a subscription run', () => {
  const devices = [device('a'), device('off', { enabled: false }), device('down', { online: false }), device('b'),
    device('old', { harnesses: [{ harness: 'claude_code', installed: true, modelSlots: [{ slot: 'top', model: 'reported-claude-top', name: 'Top' }] }] })]
  const busy = devices.map(item => item.id === 'a' ? { ...item, activeRuns: 1 } : item)
  const plan = planDispatch({ entries: [first], location: 'local', devices: busy, credential: usable, cloudReady: false })
  assert.equal(plan.kind === 'device' && plan.deviceId, 'b', 'the idle one of the two that can run it')
  // Off, offline and old devices are never picked, however idle or server they are.
  const tempting = devices.map(item => item.id === 'a' || item.id === 'b' ? { ...item, activeRuns: 9 } : { ...item, server: true })
  const still = planDispatch({ entries: [first], location: 'local', devices: tempting, credential: usable, cloudReady: false })
  assert.equal(still.kind === 'device' && still.deviceId, 'a')
  assert.equal(deviceModel(device('off', { enabled: false }), first), null, '参与调度 off: never sent a run')
  assert.equal(deviceModel(device('x'), keyed), 'key-model', 'an API key model runs on any installed Agent of its protocol')
  assert.equal(deviceModel(device('x', { harnesses: [] }), keyed), null)
})

test('a subscription model runs on any computer whose Agent takes subscription runs, reported by its CLI or not', () => {
  // Production 2026-11-02: online, 参与调度 on, Claude Code installed with subscriptionBroker, and no models reported at all.
  const silent = device('mac', { harnesses: [{ harness: 'claude_code', installed: true, subscriptionBroker: true }] })
  const opus = sub('9', 'claude_code', 'account-opus')
  assert.equal(deviceModel(silent, opus), 'account-opus', 'the subscription\'s model id is what runs')
  assert.equal(deviceModel(device('mac'), first), 'reported-claude-top', 'a reported slot cannot replace the provider model identity')
  const plan = planDispatch({ entries: [opus], location: 'local', devices: [silent], credential: usable, cloudReady: false })
  assert.deepEqual([plan.kind, plan.kind === 'device' && plan.model], ['device', 'account-opus'])
  // The claim is refused without a subscription broker, so that computer cannot take it; an API key model still can.
  const old = device('old', { harnesses: [{ harness: 'claude_code', installed: true }] })
  assert.equal(deviceModel(old, opus), null)
  assert.equal(deviceModel(old, keyed), 'key-model')
})

test('no computer can run it: the reason comes from the computer closest to running it', () => {
  const opus = sub('9', 'claude_code', 'account-opus')
  const old = (id: string) => device(id, { harnesses: [{ harness: 'claude_code', installed: true }] })
  const codexOnly = (id: string) => device(id, { harnesses: [{ harness: 'codex', installed: true, subscriptionBroker: true }] })
  assert.deepEqual(whyNoDevice([], opus), { why: 'none' })
  assert.deepEqual(whyNoDevice([device('mac', { enabled: false })], opus), { why: 'off', device: 'mac', count: 1 })
  assert.deepEqual(whyNoDevice([device('mac', { enabled: false }), device('box', { online: false })], opus), { why: 'offline', device: 'box', count: 1 })
  assert.deepEqual(whyNoDevice([device('box', { online: false }), codexOnly('mac')], opus), { why: 'notInstalled', device: 'mac', count: 1 })
  assert.deepEqual(whyNoDevice([codexOnly('mac'), old('MacBook Pro')], opus), { why: 'needsUpdate', device: 'MacBook Pro', count: 1 })
  assert.deepEqual(whyNoDevice([old('a'), old('b'), device('c', { enabled: false })], opus), { why: 'needsUpdate', device: 'a', count: 2 })
})

test('本地 order: a server before a computer, then the fewest unfinished runs, then the one that joined first; the same input gives the same device', () => {
  const mac = device('mac', { joinedAt: 1 })
  const server = device('server', { server: true, joinedAt: 5 })
  const plan = (devices: PoolDevice[]) => { const result = planDispatch({ entries: [first], location: 'local', devices, credential: usable, cloudReady: false }); return result.kind === 'device' ? result.deviceId : null }
  assert.equal(plan([mac, server]), 'server', 'a server first, though the computer joined earlier and is listed first')
  assert.equal(plan([mac, { ...server, activeRuns: 3 }]), 'server', 'a busy server still goes before an idle computer')
  assert.equal(plan([mac, { ...server, online: false }]), 'mac', 'no server that can run it: a computer')
  assert.equal(plan([mac, { ...server, enabled: false }]), 'mac', '参与调度 off: the computer')
  const second = device('server-2', { server: true, joinedAt: 9 })
  assert.equal(plan([second, server]), 'server', 'two idle servers: the one that joined first')
  assert.equal(plan([{ ...server, activeRuns: 2 }, { ...second, activeRuns: 1 }]), 'server-2', 'two servers: the one with fewer unfinished runs')
  assert.equal(plan([device('b'), device('a')]), 'a', 'a full tie: by id')
  for (let i = 0; i < 5; i++) assert.equal(plan([mac, second, server]), 'server', 'stable: no randomness')
  assert.equal(pickDevice([]), undefined)
})

test('a model the person picked for the thread goes first, before the list', () => {
  const plan = planDispatch({ entries: [first, second], explicit: second, location: 'local', devices: [device('mac')], credential: usable, cloudReady: false })
  assert.equal(plan.kind === 'device' && plan.entry.id, '2')
  const fallsBack = planDispatch({ entries: [first, second], explicit: second, location: 'local', devices: [device('mac')], credential: entry => entry.id === '2' ? { usable: false, reason: 'quota' } : usable(), cloudReady: false })
  assert.equal(fallsBack.kind === 'device' && fallsBack.entry.id, '1')
})

test('云端 runs the first usable model on the person\'s E2B machine', () => {
  const plan = planDispatch({ entries: [first, second], location: 'cloud', devices: [], credential: entry => entry.id === '1' ? { usable: false, reason: 'paused' } : usable(), cloudReady: true })
  assert.deepEqual([plan.kind, plan.kind === 'cloud' && plan.entry.id], ['cloud', '2'])
})

test('nothing can run: the card names why', () => {
  assert.equal(planDispatch({ entries: [], location: 'local', devices: [device('mac')], credential: usable, cloudReady: true }).kind === 'none' && 'noModels', 'noModels')
  const cloud = planDispatch({ entries: [first], location: 'cloud', devices: [], credential: usable, cloudReady: false })
  assert.deepEqual([cloud.kind, cloud.kind === 'none' && cloud.reason], ['none', 'cloudNotConfigured'])
  const local = planDispatch({ entries: [first, second], location: 'local', devices: [device('off', { enabled: false })], credential: usable, cloudReady: true })
  assert.deepEqual([local.kind, local.kind === 'none' && local.reason], ['none', 'noDevice'])
  const spent = planDispatch({ entries: [first, second], location: 'local', devices: [device('mac')], credential: () => ({ usable: false, reason: 'quota' }), cloudReady: true })
  assert.deepEqual([spent.kind, spent.kind === 'none' && spent.reason], ['none', 'unavailable'])
})

test('an untouched list: opus first, then the first Codex model reported, else the first model anything reported', () => {
  const sub = (connectionId: string) => ({ kind: 'subscription' as const, connectionId })
  const key = (keyId: string) => ({ kind: 'api_key' as const, keyId })
  const claude = [
    { harness: 'claude_code' as const, model: 'reported-sonnet-x', name: 'Sonnet X', source: sub('c') },
    { harness: 'claude_code' as const, model: 'reported-opus-x', name: 'Opus X', source: sub('c') },
  ]
  const chatgpt = [
    { harness: 'codex' as const, model: 'reported-codex-top', name: 'reported-codex-top', source: sub('g') },
    { harness: 'codex' as const, model: 'reported-codex-next', name: 'reported-codex-next', source: sub('g') },
  ]
  const deepseek = [
    { harness: 'claude_code' as const, model: 'reported-deepseek-chat', name: 'reported-deepseek-chat', source: key('d') },
    { harness: 'claude_code' as const, model: 'reported-deepseek-reasoner', name: 'reported-deepseek-reasoner', source: key('d') },
  ]
  const models = (items: Parameters<typeof defaultOrder>[0]) => defaultOrder(items).map(item => item.model)
  assert.deepEqual(models(chatgpt), ['reported-codex-top'], 'only ChatGPT: its Codex model, no tier word needed')
  assert.deepEqual(models([...claude, ...chatgpt]), ['reported-opus-x', 'reported-codex-top'], 'Claude and ChatGPT: opus, then Codex')
  assert.deepEqual(models(deepseek), ['reported-deepseek-chat'], 'only a DeepSeek key: its first model')
  assert.deepEqual(models(claude), ['reported-opus-x'], 'no Codex: opus only')
  assert.deepEqual(models([...claude, ...deepseek]), ['reported-opus-x'], 'opus placed: other keys stay out')
  // A key that runs Claude Code and reports opus counts; a subscription's opus wins over it.
  const keyOpus = { harness: 'claude_code' as const, model: 'key-opus', name: 'key-opus', source: key('k') }
  assert.deepEqual(models([keyOpus]), ['key-opus'])
  assert.deepEqual(models([keyOpus, ...claude]), ['reported-opus-x'])
  // An OpenAI-compatible key reports Codex models too.
  assert.deepEqual(models([{ harness: 'codex' as const, model: 'key-codex', name: 'key-codex', source: key('o') }]), ['key-codex'])
  assert.deepEqual(models([]), [], 'nothing connected: nothing')
  // A DeepSeek key serves both Agents: alone, its first model on Claude Code; beside ChatGPT, ChatGPT's Codex model still comes second.
  const both = deepseek.flatMap(item => [item, { ...item, harness: 'codex' as const }])
  assert.deepEqual(defaultOrder(both).map(item => [item.model, item.harness]), [['reported-deepseek-chat', 'claude_code']])
  assert.deepEqual(defaultOrder([...claude, ...chatgpt, ...both]).map(item => [item.model, item.harness]), [['reported-opus-x', 'claude_code'], ['reported-codex-top', 'codex']])
  // 优先使用的 Agent Codex: the same DeepSeek model lands on Codex instead.
  assert.deepEqual(defaultOrder(both, 'codex').map(item => [item.model, item.harness]), [['reported-deepseek-chat', 'codex']])
  assert.deepEqual(defaultOrder([...claude, ...both], 'codex').map(item => [item.model, item.harness]), [['reported-opus-x', 'claude_code'], ['reported-deepseek-chat', 'codex']])
  // Which Agents run each model and credential; one-Agent credentials are untouched by the preference.
  assert.deepEqual(agentsByOffer(both).get(`reported-deepseek-chat\u0000d`), ['claude_code', 'codex'])
  assert.deepEqual(onPreferredAgent([...claude, ...both], 'codex').map(item => item.harness), ['claude_code', 'claude_code', 'codex', 'codex'])
})
