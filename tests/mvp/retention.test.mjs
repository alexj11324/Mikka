import assert from 'node:assert/strict'
import test from 'node:test'
import { finishMvpResources, resourceRecord, retainMvpResources } from './retention.mjs'

test('all environments retain resources', () => {
  assert.equal(retainMvpResources({}), true)
  assert.equal(retainMvpResources({ MIKKA_MVP_RETAIN: '0' }), true)
  assert.equal(retainMvpResources({ CI: 'true', GITHUB_ACTIONS: 'true' }), true)
  assert.equal(retainMvpResources({ CI: 'true', GITHUB_ACTIONS: 'true', MIKKA_MVP_RETAIN: '1' }), true)
})

test('retention revokes credentials without invoking stop or resource cleanup', async () => {
  const calls = []
  await finishMvpResources({ retain: true, stop: async () => calls.push('stop'), cleanup: async () => calls.push('cleanup'), revoke: async () => calls.push('revoke') })
  assert.deepEqual(calls, ['revoke'])
  await finishMvpResources({ retain: false, stop: async () => calls.push('ci-stop'), cleanup: async () => calls.push('ci-cleanup') })
  assert.deepEqual(calls, ['revoke'])
})

test('resource index admits only explicitly identified resource types', () => {
  assert.deepEqual(JSON.parse(resourceRecord('run-id', 'synthetic-run')), { kind: 'run-id', value: 'synthetic-run' })
  assert.throws(() => resourceRecord('credential', 'secret'))
  assert.throws(() => resourceRecord('owner-id', 'bad\nline'))
})
