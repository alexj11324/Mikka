import assert from 'node:assert/strict'
import { test } from 'node:test'
import { devicePresenceView, deviceSchedulingView } from './device-scheduling'
import { planDispatch, type OrderEntry, type PoolDevice } from './model-order-plan'

const now = Date.parse('2026-11-06T12:00:00Z')
const entry: OrderEntry = { id: 'model', harness: 'codex', model: 'gpt-test', source: { kind: 'api_key', keyId: 'key' } }
const device = (id: string, server: boolean, patch = {}): PoolDevice & { lastSeenAt: Date } => ({ id, name: id, server, online: true, enabled: true,
  joinedAt: 0, activeRuns: 0, lastSeenAt: new Date(now), harnesses: [{ harness: 'codex', installed: true }], ...patch })
const input = { location: 'cloud' as const, entries: [entry], credential: () => ({ usable: true as const }), cloudReady: true, cloudModel: () => 'ready' as const, now }

test('dispatch ranks match cloud-first and local-first planner selection, load and exclusions', () => {
  const devices = [device('laptop', false), device('server-busy', true, { activeRuns: 2 }), device('server-idle', true), device('excluded', true, { enabled: false })]
  const cloud = deviceSchedulingView({ ...input, devices })
  assert.deepEqual(cloud.filter(node => node.order !== null).map(node => node.id), ['cloud', 'server-idle', 'server-busy', 'laptop'])
  const local = deviceSchedulingView({ ...input, location: 'local', devices })
  assert.deepEqual(local.filter(node => node.order !== null).map(node => node.id), ['server-idle', 'server-busy', 'laptop'])
  const plan = planDispatch({ ...input, location: 'local', devices })
  assert.equal(plan.kind === 'device' && plan.deviceId, local[0].id)
  assert.equal(local.find(node => node.id === 'excluded')?.availability, 'excluded')
})

test('future, offline, uninstalled and unavailable models have backend reasons and no dispatch rank', () => {
  const devices = [device('future', false, { lastSeenAt: new Date('2036-11-06') }), device('offline', false, { online: false, lastSeenAt: new Date(now - 3 * 86_400_000) }), device('uninstalled', true, { harnesses: [] })]
  const nodes = deviceSchedulingView({ ...input, location: 'local', devices })
  assert.ok(nodes.every(node => node.order === null))
  assert.equal(nodes.find(node => node.id === 'future')?.reason, 'future_heartbeat')
  assert.equal(nodes.find(node => node.id === 'future')?.offlineDays, null)
  assert.equal(nodes.find(node => node.id === 'offline')?.offlineDays, 3)
  assert.equal(nodes.find(node => node.id === 'uninstalled')?.reason, 'notInstalled')
  assert.deepEqual(devicePresenceView(null, false, now), { presenceReason: 'never_seen', offlineDays: null })
})

test('per-harness supported models come from the same account-aware device support as dispatch', () => {
  const [node] = deviceSchedulingView({ ...input, location: 'local', devices: [device('local', false)] })
  assert.deepEqual(node.harnesses, [{ harness: 'codex', installed: true, models: ['gpt-test'] }])
  assert.deepEqual(node.models, [{ id: 'gpt-test', harness: 'codex', available: true, reason: 'ready' }])
})

test('dispatch availability never depends on a device model report', () => {
  const full: OrderEntry = { id: 'historical', harness: 'claude_code', model: 'claude-sonnet-5', source: { kind: 'subscription', connectionId: 'own-connection' } }
  const nodes = deviceSchedulingView({ ...input, location: 'local', entries: [full], devices: [
    device('local', false, { harnesses: [{ harness: 'claude_code', installed: true, subscriptionBroker: true, models: ['sonnet'] }] }),
  ] })
  assert.equal(nodes[0].models[0].available, true)
  assert.equal(nodes[0].models[0].reason, 'ready')
  assert.equal(nodes[0].order, 1)
  assert.equal('modelEvidence' in nodes[0].models[0], false)
})

test('an earlier credential check keeps the node checking instead of inventing an install/update failure', () => {
  const earlier: OrderEntry = { ...entry, id: 'checking', harness: 'claude_code' }
  const [node] = deviceSchedulingView({ ...input, location: 'local', entries: [earlier, entry], devices: [device('local', false)],
    credential: value => value.id === 'checking' ? { usable: false, reason: 'checking' } : { usable: true } })
  assert.equal(node.order, null)
  assert.equal(node.reason, 'checking')
})
