import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'

const originalSecret = process.env.CRON_SECRET
const secret = 'source-only-cron-test-secret'
const verifyBearer = mock.fn(async (_value: string | null, _secret: string) => false)
const redeliver = mock.fn(async () => ({ configured: true, scanned: 0, failed: 0, redelivered: 0, errors: 0 }))
mock.module(new URL('../../../../lib/linear-sync/webhook.ts', import.meta.url).href, { namedExports: { verifyBearer } })
mock.module(new URL('../../../../lib/suggestions/github-redelivery.ts', import.meta.url).href, { namedExports: { redeliverFailedGitHubWebhooks: redeliver } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => {
  verifyBearer.mock.resetCalls()
  redeliver.mock.resetCalls()
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
  assert.equal(redeliver.mock.callCount(), 0)
})

test('an invalid bearer returns 401 without accessing GitHub', async () => {
  process.env.CRON_SECRET = secret
  const response = await GET(new Request('https://preview.example.test/mikka/api/cron/suggestions-reconcile', {
    headers: { authorization: 'Bearer incorrect-test-secret' },
  }))
  assert.equal(response.status, 401)
  assert.deepEqual(verifyBearer.mock.calls.map(call => call.arguments), [['Bearer incorrect-test-secret', secret]])
  assert.equal(redeliver.mock.callCount(), 0)
})
