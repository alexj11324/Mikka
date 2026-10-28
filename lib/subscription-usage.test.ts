import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSubscriptionUsage, usageCache, type SubscriptionUsage } from './subscription-usage'

const id = '00000000-0000-4000-8000-000000000001'

test('codex usage shows what is left of the 5-hour and weekly windows, with the plan', () => {
  // The worker's projection of chatgpt.com/backend-api/wham/usage.
  const body = {
    plan_type: 'plus',
    credits: { has_credits: true, unlimited: false },
    rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1793000000 },
      secondary_window: { used_percent: 92.4, limit_window_seconds: 604800, reset_at: 1793400000 },
    },
    additional_rate_limits: [{ limit_name: 'Additional', rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800 } } }],
  }
  assert.deepEqual(parseSubscriptionUsage(id, 'codex', { status: 200, body, account: 'alex@example.com' }), {
    id, status: 'ok', account: 'alex@example.com', plan: 'Plus',
    windows: [
      { kind: 'five_hour', remaining: 75, resetsAt: new Date(1793000000 * 1000).toISOString() },
      { kind: 'weekly', remaining: 8, resetsAt: new Date(1793400000 * 1000).toISOString() },
    ],
  })
})

test('claude usage reads utilization as used, skips one-model weeks and names no plan', () => {
  // The worker's projection of api.anthropic.com/api/oauth/usage.
  const body = {
    extra_usage: { is_enabled: false },
    five_hour: { utilization: 0, resets_at: '2026-10-28T12:00:00Z' },
    seven_day: { utilization: 100, resets_at: '2026-11-02T08:00:00Z' },
    seven_day_opus: { utilization: 10 },
    seven_day_sonnet: {},
  }
  const result = parseSubscriptionUsage(id, 'claude', { status: 200, body })
  assert.equal(result.plan, null)
  assert.equal(result.account, null)
  assert.deepEqual(result.windows, [
    { kind: 'five_hour', remaining: 100, resetsAt: '2026-10-28T12:00:00.000Z' },
    { kind: 'weekly', remaining: 0, resetsAt: '2026-11-02T08:00:00.000Z' },
  ])
})

test('only windows the provider returned are shown', () => {
  const result = parseSubscriptionUsage(id, 'codex', { status: 200, body: { plan_type: 'pro', rate_limit: { secondary_window: { used_percent: 40, limit_window_seconds: 604800 } } } })
  assert.equal(result.status, 'ok')
  assert.equal(result.plan, 'Pro')
  assert.deepEqual(result.windows, [{ kind: 'weekly', remaining: 60, resetsAt: null }])
  const empty = parseSubscriptionUsage(id, 'claude', { status: 200, body: { five_hour: { utilization: 'x' } } })
  assert.deepEqual(empty.windows, [])
})

test('a refused or malformed answer is unavailable, and a non-email account is dropped', () => {
  assert.deepEqual(parseSubscriptionUsage(id, 'claude', { status: 401, body: {}, account: 'alex@example.com' }), { id, status: 'unavailable', account: 'alex@example.com', plan: null, windows: [] })
  assert.equal(parseSubscriptionUsage(id, 'codex', { status: 200, body: null }).status, 'unavailable')
  for (const account of ['Bearer abc', 'no-at-sign', '<a@b>', 42]) assert.equal(parseSubscriptionUsage(id, 'codex', { status: 200, body: {}, account }).account, null)
})

test('usage is read once per key a minute', async () => {
  let clock = 0
  let reads = 0
  const cache = usageCache(60_000, () => clock)
  const read = async (): Promise<SubscriptionUsage> => { reads++; return { id, status: 'ok', account: null, plan: null, windows: [] } }
  await cache('a', read); await cache('a', read)
  assert.equal(reads, 1)
  clock = 59_999; await cache('a', read)
  assert.equal(reads, 1)
  clock = 60_000; await cache('a', read)
  assert.equal(reads, 2)
  await cache('b', read)
  assert.equal(reads, 3)
})
