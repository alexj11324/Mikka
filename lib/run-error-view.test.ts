import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CodedError } from '@mikka/protocol/coded-error'
import { USER_ERROR_CODES } from '@mikka/protocol/user-error-codes'
import { runErrorCopy } from './run-error-view'

const catalogues = ['messages/zh-CN.json', 'messages/en.json'].map(file => JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, Record<string, string>>>)
const words = (copy: NonNullable<ReturnType<typeof runErrorCopy>>, catalogue: (typeof catalogues)[number]) =>
  copy.key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalogue[copy.namespace])

test('a stored run error with a registered code shows its copy, distinct per detail; the raw code goes to the details area', () => {
  const lease = runErrorCopy(new CodedError('subscription_local_runtime_unavailable', { detail: 'lease_refused' }).message)
  const model = runErrorCopy('subscription_local_runtime_unavailable (model_mismatch)')
  assert.deepEqual(lease, { namespace: 'RunErrors', key: 'subscription_local_runtime_unavailable.lease_refused', code: 'subscription_local_runtime_unavailable (lease_refused)' })
  assert.equal(model?.key, 'subscription_local_runtime_unavailable.model_mismatch')
  for (const catalogue of catalogues) {
    assert.equal(typeof words(lease!, catalogue), 'string')
    assert.notEqual(words(lease!, catalogue), words(model!, catalogue))
    // The copy never shows the code itself.
    assert.doesNotMatch(String(words(lease!, catalogue)), /_unavailable|lease_refused/)
  }
})

test('every registered code and detail resolves to copy in both catalogues', () => {
  for (const [code, details] of Object.entries(USER_ERROR_CODES)) {
    for (const detail of [null, ...details]) {
      const copy = runErrorCopy(detail ? `${code} (${detail})` : code)
      assert.ok(copy, code)
      for (const catalogue of catalogues) assert.equal(typeof words(copy, catalogue), 'string', `${copy.key}`)
    }
  }
})

test('an unknown detail falls back to the code\'s own line; old rows without a detail still read', () => {
  assert.equal(runErrorCopy('subscription_hosted_runtime_unavailable (something_new)')?.key, 'subscription_hosted_runtime_unavailable.default')
  assert.equal(runErrorCopy('subscription_hosted_runtime_unavailable')?.key, 'subscription_hosted_runtime_unavailable.default')
  assert.equal(runErrorCopy('\nsubscription_local_runtime_unavailable\n')?.key, 'subscription_local_runtime_unavailable.default')
})

test('subscription refusal codes reuse the chat\'s refusal copy, with or without a detail', () => {
  assert.deepEqual(runErrorCopy('subscription_model_not_reported'), { namespace: 'Coordinator', key: 'subscriptionRefusal.modelNotReported', code: 'subscription_model_not_reported' })
  assert.equal(runErrorCopy('backend_unavailable (capability_missing)')?.key, 'subscriptionRefusal.retry')
})

test('an agent\'s own failure text is shown as it is', () => {
  for (const text of ['Model provider failed (balance: payment_required; HTTP 402)', 'Repository URL required; dispatch a new thread.', 'unknown_code', '', null])
    assert.equal(runErrorCopy(text), null)
})
