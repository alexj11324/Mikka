import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultOrder, deviceModel, planDispatch, type CredentialState, type OrderEntry, type PoolDevice } from './model-order-plan'

// Model names here are fixtures standing for what a CLI or provider reported.
const sub = (id: string, harness: OrderEntry['harness'], model: string, connectionId = `conn-${harness}`): OrderEntry => ({ id, harness, model, source: { kind: 'subscription', connectionId } })
const key = (id: string, harness: OrderEntry['harness'], model: string): OrderEntry => ({ id, harness, model, source: { kind: 'api_key', keyId: 'key-1' } })
const device = (id: string, over: Partial<PoolDevice> = {}): PoolDevice => ({
  id, online: true, enabled: true,
  harnesses: [
    { harness: 'claude_code', installed: true, modelSlots: [{ slot: 'top', model: 'reported-claude-top', name: 'Top' }] },
    { harness: 'codex', installed: true, models: ['reported-codex-a'] },
  ],
  ...over,
})
const usable = (): CredentialState => ({ usable: true })
const first = sub('1', 'claude_code', 'reported-claude-top')
const second = sub('2', 'codex', 'reported-codex-a')
const keyed = key('3', 'claude_code', 'key-model')

test('the first allowed model that can run takes the run; the slot its CLI reported is what runs', () => {
  const plan = planDispatch({ entries: [first, second], location: 'local', devices: [device('mac')], credential: usable, cloudReady: false })
  assert.deepEqual([plan.kind, plan.kind === 'device' && plan.entry.id, plan.kind === 'device' && plan.model], ['device', '1', 'top'])
})

test('ordered fallback: quota used up, signed out, or no device moves to the next model, and says why each was skipped', () => {
  const credential = (entry: OrderEntry): CredentialState => entry.id === '1' ? { usable: false, reason: 'quota', resetsAt: '2026-11-02T14:20:00Z' } : usable()
  const plan = planDispatch({ entries: [first, second], location: 'local', devices: [device('mac')], credential, cloudReady: false })
  assert.equal(plan.kind === 'device' && plan.entry.id, '2')
  assert.deepEqual(plan.skipped.map(item => [item.entry.id, item.block.reason]), [['1', 'quota']])
  const noClaude = planDispatch({ entries: [first, second], location: 'local', devices: [device('box', { harnesses: [{ harness: 'codex', installed: true, models: ['reported-codex-a'] }] })], credential: usable, cloudReady: false })
  assert.deepEqual([noClaude.kind === 'device' && noClaude.entry.id, noClaude.skipped.map(item => item.block.reason)], ['2', ['noDevice']])
  const expired = planDispatch({ entries: [first, second], location: 'local', devices: [device('mac')], credential: entry => entry.id === '2' ? usable() : { usable: false, reason: 'expired' }, cloudReady: false })
  assert.equal(expired.kind === 'device' && expired.entry.id, '2')
})

test('本地 picks at random among the devices that can run it, never one with 参与调度 off, offline, or without the model', () => {
  const devices = [device('a'), device('off', { enabled: false }), device('down', { online: false }), device('b'),
    device('other', { harnesses: [{ harness: 'claude_code', installed: true, models: ['reported-elsewhere'] }] })]
  const picked = new Set<string>()
  for (const value of [0, 0.49, 0.5, 0.99]) {
    const plan = planDispatch({ entries: [first], location: 'local', devices, credential: usable, cloudReady: false, random: () => value })
    if (plan.kind === 'device') picked.add(plan.deviceId)
  }
  assert.deepEqual([...picked].sort(), ['a', 'b'])
  assert.equal(deviceModel(device('off', { enabled: false }), first), null, '参与调度 off: never sent a run')
  assert.equal(deviceModel(device('x'), keyed), 'key-model', 'an API key model runs on any installed Agent of its protocol')
  assert.equal(deviceModel(device('x', { harnesses: [] }), keyed), null)
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

test('an untouched list starts with Claude Code\'s opus, then Codex\'s strongest tier, from subscriptions only, and skips what nothing reported', () => {
  const candidates = [
    { harness: 'claude_code' as const, model: 'reported-sonnet-x', name: 'Sonnet X', source: { kind: 'subscription' as const, connectionId: 'c' } },
    { harness: 'claude_code' as const, model: 'reported-opus-x', name: 'Opus X', source: { kind: 'subscription' as const, connectionId: 'c' } },
    { harness: 'codex' as const, model: 'reported-codex-xhigh', name: 'Codex (Extra High)', source: { kind: 'subscription' as const, connectionId: 'g' } },
    { harness: 'claude_code' as const, model: 'key-opus', name: 'key-opus', source: { kind: 'api_key' as const, keyId: 'k' } },
  ]
  assert.deepEqual(defaultOrder(candidates).map(item => item.model), ['reported-opus-x', 'reported-codex-xhigh'])
  assert.deepEqual(defaultOrder(candidates.slice(2)).map(item => item.model), ['reported-codex-xhigh'], 'no Claude subscription: Codex first')
  assert.deepEqual(defaultOrder(candidates.slice(0, 2)).map(item => item.model), ['reported-opus-x'], 'no Codex: Claude only')
  assert.deepEqual(defaultOrder(candidates.slice(3)), [], 'an API key is never added on its own')
})
