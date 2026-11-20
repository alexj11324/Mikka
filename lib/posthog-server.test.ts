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

test('local overrides exercise on and off without inheriting cached remote values', async () => {
  const previous = { node: process.env.NODE_ENV, flags: process.env.MIKKA_FLAG_OVERRIDES }
  try {
    process.env.NODE_ENV = 'test'
    clearFlagCache()
    const client = fake(async () => true)
    assert.equal(await serverFlagEnabled('local-example', 'u1', { posthog: client.posthog }), true)
    process.env.MIKKA_FLAG_OVERRIDES = '{"local-example":false}'
    assert.equal(await serverFlagEnabled('local-example', 'u1', { posthog: client.posthog }), false)
    process.env.MIKKA_FLAG_OVERRIDES = '{"local-example":true}'
    assert.equal(await serverFlagEnabled('local-example', 'u1', { posthog: null }), true)
    assert.equal(client.checks(), 1)
    process.env.MIKKA_FLAG_OVERRIDES = '{"local-example":"false"}'
    await assert.rejects(serverFlagEnabled('local-example', 'u1', { posthog: null }), /REQUIRE_BOOLEANS/)
    process.env.MIKKA_FLAG_OVERRIDES = 'not-json'
    await assert.rejects(serverFlagEnabled('local-example', 'u1', { posthog: null }), /INVALID_JSON/)
  } finally {
    if (previous.node === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous.node
    if (previous.flags === undefined) delete process.env.MIKKA_FLAG_OVERRIDES
    else process.env.MIKKA_FLAG_OVERRIDES = previous.flags
    clearFlagCache()
  }
})

test('production and unclassified runtimes ignore local overrides, including malformed JSON', async () => {
  const previous = { node: process.env.NODE_ENV, flags: process.env.MIKKA_FLAG_OVERRIDES }
  try {
    for (const runtime of ['production', 'preview', undefined]) {
      if (runtime === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = runtime
      for (const flags of ['{"mikka-cloud-computer":false,"mikka-computer-billing":true}', 'not-json']) {
        process.env.MIKKA_FLAG_OVERRIDES = flags
        clearFlagCache()
        assert.equal(await serverFlagEnabled('mikka-cloud-computer', 'u1', { posthog: null }), true)
        assert.equal(await serverFlagEnabled('mikka-computer-billing', 'u1', { posthog: null }), false)
      }
    }
  } finally {
    if (previous.node === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous.node
    if (previous.flags === undefined) delete process.env.MIKKA_FLAG_OVERRIDES
    else process.env.MIKKA_FLAG_OVERRIDES = previous.flags
    clearFlagCache()
  }
})
