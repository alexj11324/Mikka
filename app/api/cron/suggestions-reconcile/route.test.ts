import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { ReconcileResult } from '@/lib/suggestions/reconcile'

const originalSecret = process.env.CRON_SECRET
const secret = 'source-only-cron-test-secret'
const verifyBearer = mock.fn(async (_value: string | null, _secret: string) => false)
const result = (): ReconcileResult => ({ people: 2, read: { gmail: 3 }, failed: {}, deferred: 1, linear: { deliveries: 4, notifications: 2 }, github: { configured: true, scanned: 30, failed: 27, redelivered: 25, errors: 0 } })
const reconcile = mock.fn(async (_options: { deadline: number }) => result())
mock.module(new URL('../../../../lib/linear-sync/webhook.ts', import.meta.url).href, { namedExports: { verifyBearer } })
mock.module(new URL('../../../../lib/suggestions/reconcile.ts', import.meta.url).href, { namedExports: { reconcileSuggestions: reconcile } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => {
  verifyBearer.mock.resetCalls()
  verifyBearer.mock.mockImplementation(async () => false)
  reconcile.mock.mockImplementation(async () => result())
  reconcile.mock.resetCalls()
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
})

test('an invalid bearer returns 401 without accessing GitHub', async () => {
  process.env.CRON_SECRET = secret
  const response = await GET(new Request('https://preview.example.test/mikka/api/cron/suggestions-reconcile', {
    headers: { authorization: 'Bearer incorrect-test-secret' },
  }))
  assert.equal(response.status, 401)
  assert.deepEqual(verifyBearer.mock.calls.map(call => call.arguments), [['Bearer incorrect-test-secret', secret]])
  assert.equal(reconcile.mock.callCount(), 0)
})

const request = () => new Request('https://preview.example.test/mikka/api/cron/suggestions-reconcile', { headers: { authorization: `Bearer ${secret}` } })

test('an authorized call preserves all nested counts and gives reconciliation a 40-second budget', async () => {
  process.env.CRON_SECRET = secret
  verifyBearer.mock.mockImplementation(async () => true)
  const started = Date.now()
  const response = await GET(request())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), result())
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
  assert.deepEqual(await response.json(), summary)
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
    assert.deepEqual(await response.json(), summary)
  }
})
