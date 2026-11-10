import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
const calls: string[] = []
const enterprise = { live: { delivered: 1, failed: 0, pending: false }, directories: 2,
  identityAudits: { delivered: 3, failed: 0 }, members: 1, policies: 1, retention: { organizations: 1, deleted: 0 } }
let route: typeof import('../app/api/cron/audit-retention/route')
before(async () => {
  mock.module('@/lib/audit/delivery', { namedExports: { deliverWorkspaceAudits: async () => { calls.push('delivery'); return { delivered: 2, failed: 0 } } } })
  mock.module('@/lib/audit/retention', { namedExports: { sweepAuditRetention: async () => { calls.push('retention'); return { scanned: 1, deleted: 0, pending: 0 } } } })
  mock.module('@/lib/enterprise/maintenance', { namedExports: {
    maintainEnterpriseGovernance: async (...args: unknown[]) => {
      assert.deepEqual(args, [], 'the existing authenticated tick invokes the bounded Enterprise maintenance entry')
      calls.push('enterprise'); return enterprise
    },
  } })
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
  assert.deepEqual(calls, ['delivery', 'enterprise', 'retention'])
  assert.deepEqual(await response.json(), { scanned: 1, deleted: 0, pending: 0, delivery: { delivered: 2, failed: 0 }, enterprise })
})
