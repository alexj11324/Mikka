import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let calls = 0
let fail = false
const secret = 'isolated-recovery-cron-fixture'
mock.module(new URL('../../../../lib/run-leases.ts', import.meta.url).href, { namedExports: {
  sweepExpiredRunLeases: async () => { calls++; if (fail) throw new Error('private-database-error'); return { owners: 3, failed: 1 } },
} })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => { process.env.CRON_SECRET = secret; calls = 0; fail = false })
const call = (token: string | null = secret) => GET(new Request('http://127.0.0.1/mikka/api/cron/run-recovery', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}))

test('independent recovery requires the existing cron bearer before scanning owners', async () => {
  for (const token of [null, 'incorrect']) assert.equal((await call(token)).status, 401)
  delete process.env.CRON_SECRET
  assert.equal((await call()).status, 503)
  assert.equal(calls, 0)
})

test('recovery returns bounded counts and no private database error or cached result', async () => {
  const response = await call()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { owners: 3, failed: 1 })
  fail = true
  const failed = await call()
  assert.equal(failed.status, 502)
  assert.doesNotMatch(await failed.text(), /private-database-error/)
})
