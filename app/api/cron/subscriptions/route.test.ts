import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

// The hourly subscription cleanup (#1371): one pre-check statement when nothing is due.
const secret = 'isolated-subscriptions-cron-fixture'
let due = false, flags = true, batches = 0, checks = 0
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../../../../lib/db/index.ts', { pool: {} })
stub('../../../../lib/subscription-acquire-expiry.ts', { subscriptionCleanupDue: async () => { checks++; return due } })
stub('../../../../lib/subscription-runtime.ts', { subscriptionRuntime: () => ({ cleanupBatch: async () => { batches++; return { expired: 1, processed: 0, results: [] } } }) })
stub('../../../../lib/cloud-computer-flag.ts', { byosEnabled: () => flags, byosEnrollmentEnabled: () => false })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => { process.env.CRON_SECRET = secret; due = false; flags = true; batches = 0; checks = 0 })
const call = (token: string | null = secret) => GET(new Request('http://127.0.0.1/mikka/api/cron/subscriptions', { headers: token ? { authorization: `Bearer ${token}` } : {} }))

test('only the cron bearer can run the cleanup', async () => {
  assert.equal((await call(null)).status, 401)
  assert.equal((await call('incorrect')).status, 401)
  assert.equal(checks + batches, 0)
})

test('an hour with nothing expired runs only the pre-check, and starts no worker', async () => {
  assert.deepEqual(await (await call()).json(), { expired: 0, processed: 0, results: [] })
  assert.deepEqual([checks, batches], [1, 0])
})

test('an abandoned sign-in past its deadline runs the existing cleanup batch', async () => {
  due = true
  assert.deepEqual(await (await call()).json(), { expired: 1, processed: 0, results: [] })
  assert.deepEqual([checks, batches], [1, 1])
})

test('with BYOS off nothing is read', async () => {
  flags = false
  assert.deepEqual(await (await call()).json(), { enabled: false })
  assert.equal(checks, 0)
})
