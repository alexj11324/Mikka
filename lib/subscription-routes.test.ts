import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SUBSCRIPTION_ROUTE_FLAGS, subscriptionRouteReady } from './subscription-routes'

test('a subscription route runs for an owner only when their PostHog flag is on', async () => {
  const asked: string[] = []
  const flag = (on: string[]) => async (key: string, userId: string) => { asked.push(`${key}|${userId}`); return on.includes(`${key}|${userId}`) }
  const alex = flag([`${SUBSCRIPTION_ROUTE_FLAGS.chat}|alex`])
  assert.equal(await subscriptionRouteReady('claude_cpa', 'alex', {}, alex), true)
  assert.equal(await subscriptionRouteReady('codex_cpa', 'alex', {}, alex), true)
  assert.equal(await subscriptionRouteReady('claude_cpa', 'someone', {}, alex), false, 'the flag is per person')
  assert.equal(await subscriptionRouteReady('claude_code_cli', 'alex', {}, alex), false, 'threads have their own flag')
  assert.equal(await subscriptionRouteReady('claude_code_cli', 'alex', {}, flag([`${SUBSCRIPTION_ROUTE_FLAGS.native}|alex`])), true)
  assert.equal(await subscriptionRouteReady('openai_siwc', 'alex', {}, alex), false, 'an unvalidated route never runs')
  assert.ok(asked.every(entry => entry.endsWith('|alex') || entry.endsWith('|someone')), 'evaluated for the owner, never a fixed id')
})

test('PostHog unreachable reads off; the old variables still turn a route on for test environments', async () => {
  const unreachable = async () => false
  assert.equal(await subscriptionRouteReady('claude_cpa', 'alex', {}, unreachable), false)
  assert.equal(await subscriptionRouteReady('claude_cpa', 'alex', { MIKKA_BYOS_VALIDATED_MODEL_ROUTES: 'claude_cpa,codex_cpa' }, unreachable), true)
  assert.equal(await subscriptionRouteReady('codex_cli', 'alex', { MIKKA_BYOS_VALIDATED_NATIVE_ROUTES: 'codex_cli' }, unreachable), true)
  assert.equal(await subscriptionRouteReady('claude_cpa', 'alex', { MIKKA_BYOS_VALIDATED_NATIVE_ROUTES: 'claude_cpa' }, unreachable), false, 'each list names its own routes')
})
