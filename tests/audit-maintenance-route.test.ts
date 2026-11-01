import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
const calls: string[] = []
let route: typeof import('../app/api/cron/audit-retention/route')
before(async () => {
  mock.module('@/lib/audit/delivery', { namedExports: { deliverWorkspaceAudits: async () => { calls.push('delivery'); return { delivered: 2, failed: 0 } } } })
  mock.module('@/lib/audit/retention', { namedExports: { sweepAuditRetention: async () => { calls.push('retention'); return { scanned: 1, deleted: 0, pending: 0 } } } })
  route = await import('../app/api/cron/audit-retention/route')
})
test('the existing audit maintenance tick authenticates before delivery and runs the durable relay before retention', async t => {
  const original = process.env.CRON_SECRET
  t.after(() => { if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original })
  delete process.env.CRON_SECRET
  assert.equal((await route.GET(new Request('https://mikka.example/cron'))).status, 503)
  process.env.CRON_SECRET = 'fixture-audit-maintenance-only'
  assert.equal((await route.GET(new Request('https://mikka.example/cron'))).status, 401)
  assert.equal(calls.length, 0)
  const response = await route.GET(new Request('https://mikka.example/cron', { headers: { authorization: 'Bearer fixture-audit-maintenance-only' } }))
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(calls, ['delivery', 'retention'])
  assert.deepEqual(await response.json(), { scanned: 1, deleted: 0, pending: 0, delivery: { delivered: 2, failed: 0 } })
})
