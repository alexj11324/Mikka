import assert from 'node:assert/strict'
import test from 'node:test'
import { subscriptionRecovery, subscriptionRefusal } from './subscription-refusal'

test('a subscription refusal maps to its notice, never the raw step error', () => {
  assert.equal(subscriptionRefusal('binding_required'), 'selectionChanged')
  assert.equal(subscriptionRefusal('Step "step//./workflows/coordinator/agent-kit-steps//botRuntime" failed after 3 retries: binding_required'), 'selectionChanged')
  assert.equal(subscriptionRefusal('reconnect_required'), 'reconnect')
  assert.equal(subscriptionRefusal('quota_exhausted'), 'quotaUsed')
  assert.equal(subscriptionRefusal('backend_unavailable'), 'retry')
  assert.equal(subscriptionRefusal('quota_unknown'), 'quotaChecking')
  assert.equal(subscriptionRefusal('subscription_rate_limited'), 'rateLimited')
  assert.equal(subscriptionRefusal('provider_access_denied'), 'accessDenied')
  assert.equal(subscriptionRefusal('provider_request_rejected'), 'modelRejected')
  assert.equal(subscriptionRefusal('provider_route_unavailable'), 'runtimeUnavailable')
  assert.equal(subscriptionRefusal('provider_temporarily_unavailable'), 'retry')
  assert.equal(subscriptionRefusal('invalid_credential_bundle'), 'reconnect')
})

test('recovery follows the cause rather than retrying a disconnected account', () => {
  for (const notice of ['retry', 'rateLimited', 'quotaChecking'] as const) assert.equal(subscriptionRecovery(notice), 'retry')
  for (const notice of ['reconnect', 'unavailable'] as const) assert.equal(subscriptionRecovery(notice), 'settings')
  for (const notice of ['selectionChanged', 'runtimeUnavailable', 'accessDenied', 'modelRejected'] as const) assert.equal(subscriptionRecovery(notice), 'model')
})

test('other failures keep their own message', () => {
  assert.equal(subscriptionRefusal(null), null)
  assert.equal(subscriptionRefusal('verification_required'), null)
  assert.equal(subscriptionRefusal('Client network socket disconnected before secure TLS connection was established'), null)
  assert.equal(subscriptionRefusal('wake_failed'), null)
})
