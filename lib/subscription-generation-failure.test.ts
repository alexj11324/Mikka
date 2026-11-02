import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { WorkerRefusal } from '../packages/daemon/src/subscription-worker-client'
import { generationFailureCode } from './subscription-service'

test('a failed subscription turn logs only its fixed code, never the message', () => {
  assert.equal(generationFailureCode(new WorkerRefusal('provider_operation_failed')), 'provider_operation_failed')
  assert.equal(generationFailureCode(new SubscriptionRefusal('quota_unknown')), 'quota_unknown')
  assert.equal(generationFailureCode(new TypeError('fixture provider text: secret')), 'TypeError')
  assert.equal(generationFailureCode({ code: 'Not A Code With spaces' }), 'unknown')
  assert.equal(generationFailureCode('fixture string'), 'unknown')
})
