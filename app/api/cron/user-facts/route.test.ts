import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'

const originalSecret = process.env.CRON_SECRET
const originalFlag = process.env.PROACTIVE_PROFILE_ENABLED
const secret = 'source-only-cron-test-secret'
const result = () => ({ people: 3, due: 2, written: 2, skipped: 0, failed: 0, deferred: 0 })
const consolidate = mock.fn(async (_options: { deadline: number; entitled: (userId: string) => Promise<boolean> }) => result())
const purge = mock.fn(async () => 2)
mock.module(new URL('../../../../lib/profile/store.ts', import.meta.url).href, { namedExports: { consolidateDueFacts: consolidate } })
mock.module(new URL('../../../../lib/profile/memory.ts', import.meta.url).href, { namedExports: { purgeExpiredMemoryUndo: purge } })
mock.module(new URL('../../../../lib/profile/entitlement.ts', import.meta.url).href, { namedExports: { profileEntitled: async () => true } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => {
  process.env.PROACTIVE_PROFILE_ENABLED = '1'
  consolidate.mock.resetCalls()
  purge.mock.resetCalls()
})
after(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = originalSecret
  if (originalFlag === undefined) delete process.env.PROACTIVE_PROFILE_ENABLED
  else process.env.PROACTIVE_PROFILE_ENABLED = originalFlag
})

const url = 'https://preview.example.test/mikka/api/cron/user-facts'

test('missing cron configuration returns 503 without merging', async () => {
  delete process.env.CRON_SECRET
  const response = await GET(new Request(url))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(consolidate.mock.callCount(), 0)
  assert.equal(purge.mock.callCount(), 0)
})

test('an invalid bearer returns 401 without merging', async () => {
  process.env.CRON_SECRET = secret
  const response = await GET(new Request(url, { headers: { authorization: 'Bearer incorrect-test-secret' } }))
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(consolidate.mock.callCount(), 0)
  assert.equal(purge.mock.callCount(), 0)
})

test('an authorized call returns only counts and gives the merge a 40-second budget', async () => {
  process.env.CRON_SECRET = secret
  const started = Date.now()
  const response = await GET(new Request(url, { headers: { authorization: `Bearer ${secret}` } }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { ...result(), expiredUndoPurged: 2 })
  assert.equal(purge.mock.callCount(), 1)
  const deadline = consolidate.mock.calls[0].arguments[0].deadline
  assert.ok(deadline >= started + 40_000 && deadline <= Date.now() + 40_000)
  assert.equal(typeof consolidate.mock.calls[0].arguments[0].entitled, 'function', 'the merge checks each person\'s entitlement')
})

test('with PROACTIVE_PROFILE_ENABLED off an authorized call answers 200 and merges nothing', async () => {
  process.env.CRON_SECRET = secret
  for (const value of [undefined, '0', 'false', 'yes']) {
    if (value === undefined) delete process.env.PROACTIVE_PROFILE_ENABLED
    else process.env.PROACTIVE_PROFILE_ENABLED = value
    const response = await GET(new Request(url, { headers: { authorization: `Bearer ${secret}` } }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { skipped: 'disabled', expiredUndoPurged: 2 })
  }
  assert.equal(consolidate.mock.callCount(), 0)
  assert.equal(purge.mock.callCount(), 4, 'expired undo data is purged even when profile extraction is disabled')
})
