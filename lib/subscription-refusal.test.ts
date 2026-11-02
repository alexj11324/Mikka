import assert from 'node:assert/strict'
import test from 'node:test'
import { subscriptionRefusal } from './subscription-refusal'

test('a subscription refusal maps to its notice, never the raw step error', () => {
  assert.equal(subscriptionRefusal('binding_required'), 'unavailable')
  assert.equal(subscriptionRefusal('Step "step//./workflows/coordinator/agent-kit-steps//botRuntime" failed after 3 retries: binding_required'), 'unavailable')
  assert.equal(subscriptionRefusal('reconnect_required'), 'reconnect')
  assert.equal(subscriptionRefusal('quota_exhausted'), 'quotaUsed')
  assert.equal(subscriptionRefusal('backend_unavailable'), 'retry')
  // The provider would not answer a bot chat on this subscription (Anthropic answers 429 to a non-Claude Code client).
  assert.equal(subscriptionRefusal('subscription_generation_failed'), 'cannotAnswerChats')
  assert.equal(subscriptionRefusal('Step "step//./workflows/coordinator/workflow//coordinatorTurn" failed: subscription_generation_failed'), 'cannotAnswerChats')
})

test('other failures keep their own message', () => {
  assert.equal(subscriptionRefusal(null), null)
  assert.equal(subscriptionRefusal('verification_required'), null)
  assert.equal(subscriptionRefusal('Client network socket disconnected before secure TLS connection was established'), null)
  assert.equal(subscriptionRefusal('wake_failed'), null)
})
