import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureGeneration, clearFlagCache, FLAG_CACHE_MS, serverFlagEnabled, type ServerPostHog } from './posthog-server'

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

test('a model call goes to PostHog as $ai_generation with tokens only, and never throws', t => {
  const client = fake(async () => true)
  captureGeneration('u1', { model: 'm', inputTokens: 120, outputTokens: 30, latencyMs: 1500, span: 'profile_extraction' }, { posthog: client.posthog })
  assert.deepEqual(client.captured, [{ distinctId: 'u1', event: '$ai_generation', properties: {
    $ai_model: 'm', $ai_provider: 'vercel-ai-gateway', $ai_span_name: 'profile_extraction',
    $ai_input_tokens: 120, $ai_output_tokens: 30, $ai_latency: 1.5, app: 'mikka',
  } }])
  t.mock.method(console, 'error', () => {})
  const broken: ServerPostHog = { getFeatureFlag: async () => true, capture: () => { throw new Error('queue full') }, flush: async () => { throw new Error('offline') } }
  assert.doesNotThrow(() => captureGeneration('u1', { model: 'm', inputTokens: 1, outputTokens: 1, latencyMs: 1, span: 's' }, { posthog: broken }))
  assert.doesNotThrow(() => captureGeneration('u1', { model: 'm', inputTokens: 1, outputTokens: 1, latencyMs: 1, span: 's' }, { posthog: null }))
})
