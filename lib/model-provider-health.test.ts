import assert from 'node:assert/strict'
import { test } from 'node:test'
import { providerFailureBlock, providerHealthStates } from './model-provider-health'

const now = Date.parse('2026-11-04T12:00:00Z')

test('native model rejection never changes global credential or model availability', () => {
  for (const source of ['api_key', 'subscription'] as const)
    assert.equal(providerFailureBlock(source, { kind: 'model', retryable: false, status: 404, code: 'model_not_found' }, new Date(now), now), null)
})

test('runtime balance and authentication failures remain blocked until the credential is handled', () => {
  const failedAt = new Date(now - 86_400_000)
  assert.deepEqual(providerFailureBlock('api_key', { kind: 'balance', retryable: false, status: 402 }, failedAt, now), { usable: false, reason: 'balance' })
  assert.deepEqual(providerFailureBlock('api_key', { kind: 'auth', retryable: false, status: 401 }, failedAt, now), { usable: false, reason: 'keyRefused' })
  assert.deepEqual(providerFailureBlock('subscription', { kind: 'auth', retryable: false }, failedAt, now), { usable: false, reason: 'expired' })
})

test('provider unavailability expires after two minutes, including its exact boundary', () => {
  const failure = { kind: 'unavailable', retryable: true, status: 503 }
  const failedAt = new Date(now)
  const block = { usable: false, reason: 'providerUnavailable', resetsAt: new Date(now + 120_000).toISOString() }
  assert.deepEqual(providerFailureBlock('api_key', failure, failedAt, now), block)
  assert.deepEqual(providerFailureBlock('subscription', failure, failedAt, now + 119_999), block)
  assert.equal(providerFailureBlock('api_key', failure, failedAt, now + 120_000), null)
})

test('health accepts only the structured provider contract and never returns raw errors', () => {
  for (const failure of [null, 'insufficient balance', { kind: 'quota', retryable: false }, { kind: 'balance' },
    { kind: 'auth', retryable: true }, { kind: 'balance', retryable: false, code: 'sk-raw-secret' },
    { kind: 'balance', retryable: false, message: 'Bearer sk-raw-secret' }]) {
    assert.equal(providerFailureBlock('api_key', failure, new Date(now), now), null)
  }
  assert.equal(providerFailureBlock('api_key', { kind: 'unavailable', retryable: true }, new Date('invalid'), now), null)
  assert.deepEqual(providerFailureBlock('api_key', { kind: 'auth', retryable: false, code: 'invalid_api_key', status: 401 }, new Date(now), now), { usable: false, reason: 'keyRefused' })
})

test('no authorized candidates means no credential or runtime history is read', async () => {
  const query = { query: async () => { throw new Error('unexpected credential lookup') } }
  assert.equal((await providerHealthStates(query as never, { ownerId: 'owner', workspaceId: 'workspace' }, [], now)).size, 0)
})
