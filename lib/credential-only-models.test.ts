import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deviceModel, planDispatch, type OrderEntry, type PoolDevice } from './model-order-plan'

for (const harness of ['claude_code', 'codex'] as const) test(`${harness}: an enabled credential model needs no device model report`, () => {
  const entry: OrderEntry = { id: 'historical', harness, model: 'credential-historical-model', source: { kind: 'subscription', connectionId: 'owned' } }
  const device: PoolDevice = { id: 'local', name: 'local', enabled: true, online: true, server: false, activeRuns: 0, joinedAt: 0,
    harnesses: [{ harness, installed: true, subscriptionBroker: true, models: ['other-latest-model'] }] }
  assert.equal(deviceModel(device, entry), entry.model)
  assert.equal(deviceModel({ ...device, harnesses: [{ harness, installed: true, subscriptionBroker: true }] }, entry), entry.model)
  const input = { entries: [entry], location: 'local' as const, devices: [device], cloudReady: false }
  assert.equal(planDispatch({ ...input, credential: () => ({ usable: true }) }).kind, 'device')
  assert.equal(planDispatch({ ...input, credential: () => ({ usable: false, reason: 'modelGone' }) }).kind, 'none', 'device readiness never grants model access')
  assert.equal(deviceModel({ ...device, harnesses: [{ harness, installed: true }] }, entry), null, 'subscription injection is still required')
  assert.equal(deviceModel({ ...device, enabled: false }, entry), null)
  assert.equal(deviceModel({ ...device, online: false }, entry), null)
})
