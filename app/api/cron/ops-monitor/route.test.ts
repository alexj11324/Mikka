import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'

const previous = process.env.CRON_SECRET
const secret = 'isolated-ops-cron-fixture'
let operationalFailed = false, providerFailed = false, providerFinished = false
const operations = mock.fn(async () => {
  if (operationalFailed) throw Error('private-operational-error')
  return { databaseAvailable: true, notificationStatus: 'not_configured', persisted: true }
})
const provider = mock.fn(async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 5)); providerFinished = true
  return { status: providerFailed ? 'failed' : 'collected' }
})
mock.module(new URL('../../../../lib/db/index.ts', import.meta.url).href, { namedExports: { pool: {} } })
mock.module(new URL('../../../../lib/ops/monitor.ts', import.meta.url).href, { namedExports: { collectOperationalSignals: operations } })
mock.module(new URL('../../../../lib/ops/egress-fallback.ts', import.meta.url).href, { namedExports: { collectProviderEgress: provider } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
after(() => { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous })
const request = (authorized = false) => new Request('http://127.0.0.1/mikka/api/cron/ops-monitor', { headers: authorized ? { authorization: `Bearer ${secret}` } : {} })

test('cron rejects missing and incorrect authentication before either collector runs', async () => {
  delete process.env.CRON_SECRET
  assert.equal((await GET(request())).status, 503)
  process.env.CRON_SECRET = secret
  assert.equal((await GET(request())).status, 401)
  assert.equal(operations.mock.callCount(), 0); assert.equal(provider.mock.callCount(), 0)
})

test('authorized cron retains operational outcome and exposes only fallback status', async () => {
  const response = await GET(request(true))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { databaseAvailable: true, notificationStatus: 'not_configured', persisted: true, egress: { status: 'collected' } })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('provider failure does not prevent operational persistence', async () => {
  providerFailed = true
  const before = operations.mock.callCount(), response = await GET(request(true))
  assert.equal(response.status, 503); assert.equal(operations.mock.callCount(), before + 1)
  assert.equal((await response.json()).persisted, true)
})

test('operational failure still waits for the independent provider collection', async () => {
  operationalFailed = true; providerFinished = false
  const response = await GET(request(true))
  assert.equal(response.status, 503); assert.equal(providerFinished, true)
  assert.deepEqual(await response.json(), { error: 'opsMonitorUnavailable', persisted: false })
})
