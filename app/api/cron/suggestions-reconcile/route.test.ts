import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { ReconcileResult } from '@/lib/suggestions/reconcile'

const originalSecret = process.env.CRON_SECRET
const secret = 'source-only-cron-test-secret'
const verifyBearer = mock.fn(async (_value: string | null, _secret: string) => false)
const result = (): ReconcileResult => ({ people: 2, read: { gmail: 3 }, failed: {}, reconnect: {}, deferred: 1, linear: { deliveries: 4, notifications: 2 }, github: { configured: true, scanned: 30, failed: 27, redelivered: 25, errors: 0 } })
const reconcile = mock.fn(async (_options: { deadline: number }) => result())
mock.module(new URL('../../../../lib/linear-sync/webhook.ts', import.meta.url).href, { namedExports: { verifyBearer } })
mock.module(new URL('../../../../lib/suggestions/reconcile.ts', import.meta.url).href, { namedExports: { reconcileSuggestions: reconcile } })
const sweepResult = () => ({ enabled: true, scopes: 2, observed: 3, failed: 0, deferred: 0 })
const sweep = mock.fn(async (_options: { deadline: number }) => sweepResult())
mock.module(new URL('../../../../lib/factory/monitor-cron.ts', import.meta.url).href, { namedExports: { runFactoryMonitorCron: sweep } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => {
  verifyBearer.mock.resetCalls()
  verifyBearer.mock.mockImplementation(async () => false)
  reconcile.mock.mockImplementation(async () => result())
  reconcile.mock.resetCalls()
  sweep.mock.mockImplementation(async () => sweepResult())
  sweep.mock.resetCalls()
})
after(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = originalSecret
})

test('missing cron configuration returns 503 without accessing GitHub', async () => {
  delete process.env.CRON_SECRET
  const response = await GET(new Request('https://preview.example.test/mikka/api/cron/suggestions-reconcile'))
  assert.equal(response.status, 503)
  assert.equal(verifyBearer.mock.callCount(), 0)
  assert.equal(reconcile.mock.callCount(), 0)
  assert.equal(sweep.mock.callCount(), 0, 'no Factory read or write without the bearer')
})

test('an invalid bearer returns 401 without accessing GitHub', async () => {
  process.env.CRON_SECRET = secret
  const response = await GET(new Request('https://preview.example.test/mikka/api/cron/suggestions-reconcile', {
    headers: { authorization: 'Bearer incorrect-test-secret' },
  }))
  assert.equal(response.status, 401)
  assert.deepEqual(verifyBearer.mock.calls.map(call => call.arguments), [['Bearer incorrect-test-secret', secret]])
  assert.equal(reconcile.mock.callCount(), 0)
  assert.equal(sweep.mock.callCount(), 0, 'no Factory read or write without the bearer')
})

const request = () => new Request('https://preview.example.test/mikka/api/cron/suggestions-reconcile', { headers: { authorization: `Bearer ${secret}` } })

test('an authorized call preserves all nested counts and gives reconciliation a 40-second budget', async () => {
  process.env.CRON_SECRET = secret
  verifyBearer.mock.mockImplementation(async () => true)
  const started = Date.now()
  const response = await GET(request())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { ...result(), factoryMonitor: sweepResult(), outcome: { suggestions: 'ok', factoryMonitor: 'ok' } })
  assert.equal(reconcile.mock.callCount(), 1)
  const deadline = reconcile.mock.calls[0].arguments[0].deadline
  assert.ok(deadline >= started + 40_000 && deadline <= Date.now() + 40_000)
})

test('an unconfigured GitHub backfill reports 503 with the complete result', async () => {
  process.env.CRON_SECRET = secret
  verifyBearer.mock.mockImplementation(async () => true)
  const summary = result()
  summary.github!.configured = false
  reconcile.mock.mockImplementation(async () => summary)
  const response = await GET(request())
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { ...summary, factoryMonitor: sweepResult(), outcome: { suggestions: 'ok', factoryMonitor: 'ok' } })
})

test('GitHub errors and caught source failures report 502 with the complete result', async () => {
  process.env.CRON_SECRET = secret
  verifyBearer.mock.mockImplementation(async () => true)
  for (const source of ['github-response', 'github-thrown', 'linear', 'composio', 'gmail']) {
    const summary = result()
    if (source === 'github-response') summary.github!.errors = 1
    else if (source === 'github-thrown') { summary.github = null; summary.failed.github = 1 }
    else summary.failed[source] = 1
    reconcile.mock.mockImplementation(async () => summary)
    const response = await GET(request())
    assert.equal(response.status, 502, source)
    assert.deepEqual(await response.json(), { ...summary, factoryMonitor: sweepResult(), outcome: { suggestions: 'ok', factoryMonitor: 'ok' } })
  }
})

test('a connection that needs reconnecting is reported, not a failed run', async () => {
  process.env.CRON_SECRET = secret
  verifyBearer.mock.mockImplementation(async () => true)
  const summary = result()
  summary.reconnect.notion = 1
  reconcile.mock.mockImplementation(async () => summary)
  const response = await GET(request())
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).reconnect, { notion: 1 })
})

test('the Factory monitor sweep runs once, alongside the backfill, with a 50-second budget', async () => {
  process.env.CRON_SECRET = secret
  verifyBearer.mock.mockImplementation(async () => true)
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  reconcile.mock.mockImplementation(async () => { order.push('suggestions:start'); await gate; return result() })
  sweep.mock.mockImplementation(async () => { order.push('factory'); release(); return sweepResult() })
  const started = Date.now()
  const response = await GET(request())
  assert.equal(response.status, 200)
  assert.deepEqual(order, ['suggestions:start', 'factory'], 'the sweep does not wait for the backfill')
  assert.equal(sweep.mock.callCount(), 1)
  const deadline = sweep.mock.calls[0].arguments[0].deadline
  assert.ok(deadline >= started + 50_000 && deadline <= Date.now() + 50_000)
})

test('a missing Authorization header returns 401 without any read or write', async () => {
  process.env.CRON_SECRET = secret
  const response = await GET(new Request('https://preview.example.test/mikka/api/cron/suggestions-reconcile'))
  assert.equal(response.status, 401)
  assert.deepEqual(verifyBearer.mock.calls.map(call => call.arguments), [[null, secret]])
  assert.equal(reconcile.mock.callCount(), 0)
  assert.equal(sweep.mock.callCount(), 0)
})

test('suggestions still finish when the sweep throws, and the reverse; each failure is logged without its message', async () => {
  process.env.CRON_SECRET = secret
  verifyBearer.mock.mockImplementation(async () => true)
  const errors = mock.method(console, 'error', () => {})
  sweep.mock.mockImplementation(async () => { throw new Error('token=sweep-secret') })
  let response = await GET(request())
  assert.equal(response.status, 502)
  assert.equal(reconcile.mock.callCount(), 1)
  assert.deepEqual(await response.json(), { ...result(), factoryMonitor: { enabled: true, scopes: 0, observed: 0, failed: 1, deferred: 0 }, outcome: { suggestions: 'ok', factoryMonitor: 'failed' } })
  sweep.mock.mockImplementation(async () => sweepResult())
  reconcile.mock.mockImplementation(async () => { throw new Error('token=reconcile-secret') })
  sweep.mock.resetCalls()
  response = await GET(request())
  assert.equal(response.status, 502)
  assert.equal(sweep.mock.callCount(), 1, 'the sweep still runs when the backfill throws')
  assert.deepEqual(await response.json(), { factoryMonitor: sweepResult(), outcome: { suggestions: 'failed', factoryMonitor: 'ok' } })
  const logged = JSON.stringify(errors.mock.calls.map(c => c.arguments))
  assert.ok(logged.includes('factory monitor sweep failed') && logged.includes('suggestions reconcile failed'))
  assert.ok(!logged.includes('secret'), 'no error message is logged')
  errors.mock.restore()
})

test('a failing Factory monitor scope or a thrown sweep reports 502 and keeps the backfill result', async () => {
  process.env.CRON_SECRET = secret
  verifyBearer.mock.mockImplementation(async () => true)
  sweep.mock.mockImplementation(async () => ({ ...sweepResult(), failed: 1 }))
  let response = await GET(request())
  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { ...result(), factoryMonitor: { ...sweepResult(), failed: 1 }, outcome: { suggestions: 'ok', factoryMonitor: 'ok' } })
  const errors = mock.method(console, 'error', () => {})
  sweep.mock.mockImplementation(async () => { throw new Error('password=hunter2 leaked?') })
  response = await GET(request())
  assert.equal(response.status, 502)
  assert.deepEqual((await response.json()).factoryMonitor, { enabled: true, scopes: 0, observed: 0, failed: 1, deferred: 0 })
  assert.ok(!JSON.stringify(errors.mock.calls).includes('hunter2'), 'the error message is not logged')
  errors.mock.restore()
})

test('a disabled Factory sweep leaves the status to the backfill', async () => {
  process.env.CRON_SECRET = secret
  verifyBearer.mock.mockImplementation(async () => true)
  sweep.mock.mockImplementation(async () => ({ enabled: false, scopes: 0, observed: 0, failed: 0, deferred: 0 }))
  const response = await GET(request())
  assert.equal(response.status, 200)
})
