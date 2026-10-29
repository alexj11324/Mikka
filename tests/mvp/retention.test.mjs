import assert from 'node:assert/strict'
import test from 'node:test'
import { finishMvpResources, resourceRecord, retainMvpResources } from './retention.mjs'
import { retainMvpAccountLease } from './account-retention.mjs'

test('retained business accounts close both contexts before pool revocation and quarantine', async () => {
  const calls = []
  const account = role => ({ context: { async close() { calls.push(role) } } })
  const result = await retainMvpAccountLease({
    owner: account('owner'), peer: account('peer'),
    scope: { async release(options) {
      assert.deepEqual(calls.sort(), ['owner', 'peer'])
      assert.deepEqual(options, { outcome: 'dirty' })
      return { id: 'lease', environmentId: 'environment', generation: 3, state: 'quarantined', credentialRef: 'must-not-be-exported' }
    } },
  })
  assert.deepEqual(result, { leaseId: 'lease', environmentId: 'environment', generation: 3, state: 'quarantined', reason: 'retained-business-fixtures' })
})

test('failed browser closure still quarantines the pair and fails acceptance', async () => {
  let revoked = false
  await assert.rejects(retainMvpAccountLease({
    owner: { context: { async close() { throw new Error('synthetic close failure') } } },
    peer: { context: { async close() {} } },
    scope: { async release() { revoked = true; return { state: 'quarantined' } } },
  }), /MVP_ACCOUNT_CONTEXT_CLOSE_FAILED/)
  assert.equal(revoked, true)
})

test('retained mutations cannot be reported as reusable or suppress a lease failure', async () => {
  const context = { async close() {} }
  const accounts = { owner: { context }, peer: { context }, scope: { async release() { return { state: 'released' } } } }
  await assert.rejects(retainMvpAccountLease(accounts), /MVP_ACCOUNT_QUARANTINE_REQUIRED/)
  accounts.scope.release = async () => { throw new Error('LEASE_LOST') }
  await assert.rejects(retainMvpAccountLease(accounts), /LEASE_LOST/)
})

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
