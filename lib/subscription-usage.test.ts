import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SubscriptionRepository, type ConnectionRow } from './subscription-repository'
import { SubscriptionService } from './subscription-service'
import { failedUsage, parseSubscriptionUsage, usageCache, type SubscriptionUsage } from './subscription-usage'

const id = '00000000-0000-4000-8000-000000000001'
const at = new Date('2026-10-28T08:00:00Z')
const strip = (usage: SubscriptionUsage) => { const { observedAt, ...rest } = usage; assert.ok(Date.parse(observedAt)); return rest }

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
  assert.deepEqual(strip(parseSubscriptionUsage(id, 'codex', { status: 200, body, account: 'alex@example.com' })), {
    id, status: 'ok', account: 'alex@example.com', plan: 'Plus',
    windows: [
      { kind: 'five_hour', remaining: 75, resetsAt: new Date(1793000000 * 1000).toISOString() },
      { kind: 'weekly', remaining: 8, resetsAt: new Date(1793400000 * 1000).toISOString() },
    ],
  })
})

test('claude usage reads utilization as used, keeps one-model weeks out unless they bind first', () => {
  // The worker's projection of api.anthropic.com/api/oauth/usage.
  const body = {
    extra_usage: { is_enabled: false },
    five_hour: { utilization: 0, resets_at: '2026-10-28T12:00:00Z' },
    seven_day: { utilization: 100, resets_at: '2026-11-02T08:00:00Z' },
    seven_day_opus: { utilization: 10 },
    seven_day_sonnet: {},
  }
  const result = parseSubscriptionUsage(id, 'claude', { status: 200, body }, at)
  assert.equal(result.observedAt, at.toISOString())
  assert.equal(result.plan, null)
  assert.equal(result.account, null)
  assert.deepEqual(result.windows, [
    { kind: 'five_hour', remaining: 100, resetsAt: '2026-10-28T12:00:00.000Z' },
    { kind: 'weekly', remaining: 0, resetsAt: '2026-11-02T08:00:00.000Z' },
  ])
})

test('a one-model week below the overall week is the third line', () => {
  const body = { seven_day: { utilization: 30 }, seven_day_opus: { utilization: 95, resets_at: '2026-10-30T08:00:00Z' }, seven_day_sonnet: { utilization: 50 } }
  assert.deepEqual(parseSubscriptionUsage(id, 'claude', { status: 200, body }).windows, [
    { kind: 'weekly', remaining: 70, resetsAt: null },
    { kind: 'weekly', remaining: 5, resetsAt: '2026-10-30T08:00:00.000Z', model: 'Opus' },
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

test('401/403 asks for a new sign-in; other failures are temporary; the email survives both', () => {
  for (const status of [401, 403]) assert.deepEqual(strip(parseSubscriptionUsage(id, 'claude', { status, body: {}, account: 'alex@example.com' })), { id, status: 'reauth', account: 'alex@example.com', plan: null, windows: [] })
  for (const status of [0, 429, 500]) assert.equal(parseSubscriptionUsage(id, 'codex', { status, body: {}, account: 'alex@example.com' }).status, 'unavailable')
  assert.equal(parseSubscriptionUsage(id, 'codex', { status: 200, body: null }).status, 'unavailable')
  for (const account of ['Bearer abc', 'no-at-sign', '<a@b>', 42]) assert.equal(parseSubscriptionUsage(id, 'codex', { status: 200, body: {}, account }).account, null)
})

test('a good read is kept a minute; a failed one is read again at once', async () => {
  let clock = 0
  let reads = 0
  let next: SubscriptionUsage['status'] = 'unavailable'
  const cache = usageCache(60_000, () => clock)
  const read = async (): Promise<SubscriptionUsage> => { reads++; return { ...failedUsage(id, 'unavailable'), status: next } }
  await cache('a', read); await cache('a', read)
  assert.equal(reads, 2, 'failure was cached')
  next = 'reauth'
  await cache('a', read); await cache('a', read)
  assert.equal(reads, 4, 'reauth was cached')
  next = 'ok'
  await cache('a', read); await cache('a', read)
  assert.equal(reads, 5)
  clock = 59_999; await cache('a', read)
  assert.equal(reads, 5)
  clock = 60_000; await cache('a', read)
  assert.equal(reads, 6)
  await cache('b', read)
  assert.equal(reads, 7)
})

function serviceWith(row: Partial<ConnectionRow>, call: () => Promise<unknown>, after?: Partial<ConnectionRow>) {
  const base: ConnectionRow = { id, ownerId: 'alex', workspaceId: 'w', provider: 'claude', state: 'connected', epoch: '3', quota: null, accountLabel: null, ...row }
  const saved: string[] = []
  let lookups = 0
  const repository = Object.assign(new SubscriptionRepository({ query: async () => ({ rows: [] }) } as never), {
    connection: async () => (lookups++ === 0 ? base : { ...base, ...after }),
    saveAccountLabel: async (_row: ConnectionRow, label: string) => { saved.push(label) },
  })
  const worker = () => ({ call }) as never
  return { service: new SubscriptionService(repository, worker, { ready: () => false, nativeIsolation: 'none' }), saved }
}

test('a worker failure keeps the last known email and is temporary', async () => {
  const { service } = serviceWith({ accountLabel: 'alex@example.com' }, async () => { throw new Error('subscription_timeout') })
  const usage = await service.usage('alex', id)
  assert.equal(usage.status, 'unavailable')
  assert.equal(usage.account, 'alex@example.com')
})

test('a refresh that failed into reconnect_required is a sign-in problem', async () => {
  const { service } = serviceWith({ accountLabel: 'alex@example.com' }, async () => { throw new Error('operation_failed') }, { state: 'reconnect_required' })
  const usage = await service.usage('alex', id)
  assert.deepEqual([usage.status, usage.account], ['reauth', 'alex@example.com'])
})

test('a good read stores the email for later failures; a 401 keeps it', async () => {
  const ok = serviceWith({}, async () => ({ status: 200, body: { five_hour: { utilization: 10 } }, account: 'alex@example.com' }))
  assert.equal((await ok.service.usage('alex', id)).account, 'alex@example.com')
  assert.deepEqual(ok.saved, ['alex@example.com'])
  const refused = serviceWith({ accountLabel: 'alex@example.com' }, async () => ({ status: 401, body: {} }))
  const usage = await refused.service.usage('alex', id)
  assert.deepEqual([usage.status, usage.account], ['reauth', 'alex@example.com'])
  assert.deepEqual(refused.saved, [])
})
