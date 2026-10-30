import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
const secret = 'synthetic-cron-secret'
const original = process.env.CRON_SECRET
const reconcile = mock.fn(async (_options: unknown) => ({ scanned: 1, queued: 0, pending: 1, closed: 0, failed: 0, suppressed: 0 }))
const retry = mock.fn(async (_options: unknown) => ({ attempted: 0, failed: 0 }))
const write = mock.fn(async () => ({ result: { due: 0 }, pushed: [] }))
mock.module(new URL('../../../../lib/db/index.ts', import.meta.url).href, { namedExports: { pool: {} } })
mock.module(new URL('../../../../lib/github/ci/reconcile.ts', import.meta.url).href, { namedExports: { reconcileCi: reconcile } })
mock.module(new URL('../../../../lib/github/ci/escalation-recovery.ts', import.meta.url).href, { namedExports: { retryPendingCiEscalations: retry } })
mock.module(new URL('../../../../lib/linear-sync/webhook.ts', import.meta.url).href, { namedExports: { verifyBearer: async (header: string) => header === `Bearer ${secret}` } })
mock.module(new URL('../../../../lib/suggestions/store.ts', import.meta.url).href, { namedExports: { writeDueBriefings: write } })
mock.module(new URL('../../../../lib/coordinator/wake.ts', import.meta.url).href, { namedExports: { wakeCoordinator: async () => {} } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => { process.env.CRON_SECRET = secret; reconcile.mock.resetCalls(); reconcile.mock.mockImplementation(async () => ({ scanned: 1, queued: 0, pending: 1, closed: 0, failed: 0, suppressed: 0 })) })
after(() => { if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original })
const request = () => new Request('https://example.test/api/cron/briefings', { headers: { authorization: `Bearer ${secret}` } })
test('CI reconciliation uses existing authenticated 15-minute schedule with a budget', async () => {
  const start = Date.now(), response = await GET(request())
  assert.equal(response.status, 200)
  assert.equal(reconcile.mock.callCount(), 1)
  assert.equal(retry.mock.callCount(), 1)
  const options = reconcile.mock.calls[0].arguments[0] as { deadline: number; limit: number }
  assert.ok(options.deadline >= start && options.deadline <= Date.now() + 40_000)
  assert.equal(options.limit, 4)
})
test('CI reconciliation error is reported without losing successful briefing work', async () => {
  reconcile.mock.mockImplementation(async () => { throw Error('synthetic failure') })
  const response = await GET(request())
  assert.equal(response.status, 502)
  assert.equal((await response.json()).ci.failed, 1)
})
