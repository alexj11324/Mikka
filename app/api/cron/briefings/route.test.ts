import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
const secret = 'synthetic-cron-secret'
const original = process.env.CRON_SECRET
const originalFlag = process.env.MIKKA_CI_RESUME_ENABLED
const reconcile = mock.fn(async (_options: unknown) => ({ scanned: 1, queued: 0, pending: 1, closed: 0, failed: 0, deduped: 0, capped: 0 }))
const write = mock.fn(async () => ({ result: { due: 0 }, pushed: [] }))
mock.module(new URL('../../../../lib/db/index.ts', import.meta.url).href, { namedExports: { pool: {} } })
mock.module(new URL('../../../../lib/github/ci/reconcile.ts', import.meta.url).href, { namedExports: { reconcileCi: reconcile } })
mock.module(new URL('../../../../lib/linear-sync/webhook.ts', import.meta.url).href, { namedExports: { verifyBearer: async (header: string) => header === `Bearer ${secret}` } })
mock.module(new URL('../../../../lib/suggestions/store.ts', import.meta.url).href, { namedExports: { writeDueBriefings: write } })
mock.module(new URL('../../../../lib/coordinator/wake.ts', import.meta.url).href, { namedExports: { wakeCoordinator: async () => {} } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => { process.env.CRON_SECRET = secret; process.env.MIKKA_CI_RESUME_ENABLED = '1'; reconcile.mock.resetCalls(); write.mock.resetCalls(); reconcile.mock.mockImplementation(async () => ({ scanned: 1, queued: 0, pending: 1, closed: 0, failed: 0, deduped: 0, capped: 0 })) })
after(() => {
  if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original
  if (originalFlag === undefined) delete process.env.MIKKA_CI_RESUME_ENABLED; else process.env.MIKKA_CI_RESUME_ENABLED = originalFlag
})
const request = () => new Request('https://example.test/api/cron/briefings', { headers: { authorization: `Bearer ${secret}` } })
test('CI reconciliation uses existing authenticated 15-minute schedule with a budget', async () => {
  const start = Date.now(), response = await GET(request())
  assert.equal(response.status, 200)
  assert.equal(reconcile.mock.callCount(), 1)
  const options = reconcile.mock.calls[0].arguments[0] as { deadline: number; limit: number }
  assert.ok(options.deadline >= start && options.deadline <= Date.now() + 40_000)
  assert.equal(options.limit, 4)
})
test('CI reconcile failure is an isolated sub-task: briefing status stays 200', async () => {
  reconcile.mock.mockImplementation(async () => { throw Error('synthetic failure') })
  const errors = mock.method(console, 'error', () => {})
  try {
    const response = await GET(request())
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ci.status, 'failed')
    assert.equal(body.due, 0)
    assert.equal(write.mock.callCount(), 1)
    assert.ok(!errors.mock.calls.some(call => call.arguments.some(arg => String(arg).includes('synthetic failure'))))
  } finally { errors.mock.restore() }
})
test('CI reconcile partial failures are reported in the body without changing status', async () => {
  reconcile.mock.mockImplementation(async () => ({ scanned: 2, queued: 0, pending: 1, closed: 0, failed: 1, deduped: 0, capped: 0 }))
  const errors = mock.method(console, 'error', () => {})
  try {
    const response = await GET(request())
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ci.failed, 1)
  } finally { errors.mock.restore() }
})
test('flag off (default): no CI reconcile, and the response is the pre-CI shape', async () => {
  for (const value of [undefined, '0', 'yes']) {
    if (value === undefined) delete process.env.MIKKA_CI_RESUME_ENABLED; else process.env.MIKKA_CI_RESUME_ENABLED = value
    const response = await GET(request())
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { due: 0, pushed: 0 })
  }
  assert.equal(reconcile.mock.callCount(), 0)
})
