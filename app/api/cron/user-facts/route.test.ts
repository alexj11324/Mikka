import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'

const originalSecret = process.env.CRON_SECRET
const secret = 'source-only-cron-test-secret'
const verifyBearer = mock.fn(async (_value: string | null, _secret: string) => false)
const result = () => ({ people: 3, due: 2, written: 2, skipped: 0, failed: 0, deferred: 0 })
const consolidate = mock.fn(async (_options: { deadline: number }) => result())
mock.module(new URL('../../../../lib/linear-sync/webhook.ts', import.meta.url).href, { namedExports: { verifyBearer } })
mock.module(new URL('../../../../lib/profile/store.ts', import.meta.url).href, { namedExports: { consolidateDueFacts: consolidate } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => {
  verifyBearer.mock.resetCalls()
  verifyBearer.mock.mockImplementation(async () => false)
  consolidate.mock.resetCalls()
})
after(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = originalSecret
})

const url = 'https://preview.example.test/mikka/api/cron/user-facts'

test('missing cron configuration returns 503 without merging', async () => {
  delete process.env.CRON_SECRET
  const response = await GET(new Request(url))
  assert.equal(response.status, 503)
  assert.equal(verifyBearer.mock.callCount(), 0)
  assert.equal(consolidate.mock.callCount(), 0)
})

test('an invalid bearer returns 401 without merging', async () => {
  process.env.CRON_SECRET = secret
  const response = await GET(new Request(url, { headers: { authorization: 'Bearer incorrect-test-secret' } }))
  assert.equal(response.status, 401)
  assert.deepEqual(verifyBearer.mock.calls.map(call => call.arguments), [['Bearer incorrect-test-secret', secret]])
  assert.equal(consolidate.mock.callCount(), 0)
})

test('an authorized call returns only counts and gives the merge a 40-second budget', async () => {
  process.env.CRON_SECRET = secret
  verifyBearer.mock.mockImplementation(async () => true)
  const started = Date.now()
  const response = await GET(new Request(url, { headers: { authorization: `Bearer ${secret}` } }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), result())
  const deadline = consolidate.mock.calls[0].arguments[0].deadline
  assert.ok(deadline >= started + 40_000 && deadline <= Date.now() + 40_000)
})
