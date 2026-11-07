import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearFlagCache, FLAG_CACHE_MS, serverFlagEnabled, type ServerPostHog } from './posthog-server'

function fake(answer: () => Promise<boolean | string | undefined>) {
  const captured: { distinctId: string; event: string; properties?: Record<string, unknown> }[] = []
  let checks = 0
  const posthog: ServerPostHog = {
    getFeatureFlag: async () => { checks++; return answer() },
    capture: message => { captured.push(message) },
    flush: async () => {},
  }
  return { posthog, captured, checks: () => checks }
}

test('a person flag is on only when PostHog answers exactly true', async () => {
  for (const [value, expected] of [[true, true], [false, false], ['true', false], ['control', false], [undefined, false]] as const) {
    clearFlagCache()
    assert.equal(await serverFlagEnabled('mikka-proactive-profile', 'u1', { posthog: fake(async () => value).posthog }), expected, String(value))
  }
})

test('an unavailable PostHog reads off: no client, an error or a timeout', async t => {
  t.mock.method(console, 'error', () => {})
  clearFlagCache()
  assert.equal(await serverFlagEnabled('mikka-proactive-profile', 'u1', { posthog: null }), false)
  clearFlagCache()
  assert.equal(await serverFlagEnabled('mikka-proactive-profile', 'u1', { posthog: fake(async () => { throw new Error('network down') }).posthog }), false)
  clearFlagCache()
  assert.equal(await serverFlagEnabled('mikka-proactive-profile', 'u1', { posthog: fake(() => new Promise(() => {})).posthog, timeoutMs: 10 }), false)
})

test('without a project, deployed subscription routes work and billing or experiments stay off', async () => {
  clearFlagCache()
  for (const key of ['mikka-byos-subscription-chat', 'mikka-byos-subscription-native', 'mikka-cloud-computer']) {
    assert.equal(await serverFlagEnabled(key, 'community-user', { posthog: null }), true, key)
  }
  for (const key of ['mikka-computer-billing', 'mikka-email-sign-in-off', 'mikka-computer-tab-off', 'mikka-proactive-research', 'mikka-upcoming-administration']) {
    assert.equal(await serverFlagEnabled(key, 'community-user', { posthog: null }), false, key)
  }
})

test('a flag value is reused for a few minutes per person and key', async () => {
  clearFlagCache()
  const client = fake(async () => true)
  const now = 1_000_000
  assert.equal(await serverFlagEnabled('k', 'u1', { posthog: client.posthog, now }), true)
  assert.equal(await serverFlagEnabled('k', 'u1', { posthog: client.posthog, now: now + 1000 }), true)
  assert.equal(client.checks(), 1)
  await serverFlagEnabled('k', 'u2', { posthog: client.posthog, now })
  await serverFlagEnabled('other', 'u1', { posthog: client.posthog, now })
  assert.equal(client.checks(), 3)
  await serverFlagEnabled('k', 'u1', { posthog: client.posthog, now: now + FLAG_CACHE_MS })
  assert.equal(client.checks(), 4)
})
