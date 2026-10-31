import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw Error('An isolated hosted alert database is required')

test('first-free-use alerts count actual postpayment receipts and legacy rows once', { skip: !target }, async t => {
  const pool = new Pool({ connectionString: target }), client = await pool.connect()
  const { pool: appPool, withDatabaseClient } = await import('../db')
  t.after(async () => {
    try { await client.query('ROLLBACK') } finally {
      client.release()
      await Promise.all([pool.end(), appPool.end()])
    }
  })
  await client.query('BEGIN')
  // Actual migrated table definitions, isolated on this fixture connection.
  // No existing allowance, ledger, alert or other test's rows are changed.
  await client.query('CREATE TEMP TABLE hosted_usage (LIKE public.hosted_usage INCLUDING ALL) ON COMMIT DROP')
  await client.query('CREATE TEMP TABLE hosted_abuse_alerts (LIKE public.hosted_abuse_alerts INCLUDING ALL) ON COMMIT DROP')
  const first = randomUUID(), second = randomUUID(), old = randomUUID(), legacy = randomUUID()
  for (const [workspaceId, hours] of [[first, 0], [first, 0], [second, 0], [old, 2], [old, 0]] as const) {
    await client.query('INSERT INTO hosted_usage (id,"workspaceId",model,state,"costMicroUsd","freeMicroUsd","unpaidMicroUsd","createdAt") VALUES ($1,$2,\'postpay\',\'settled\',1,1,1,now()-$3::int*interval \'1 hour\')', [randomUUID(), workspaceId, hours])
  }
  await client.query('INSERT INTO hosted_usage (id,"workspaceId",model,state,"reservedFree") VALUES ($1,$2,\'legacy\',\'pending\',1)', [randomUUID(), legacy])
  const { checkAbuseAlerts } = await import('./alerts')
  let externalCalls = 0
  const check = () => withDatabaseClient(client, () => checkAbuseAlerts({ MIKKA_FREE_MODEL_FIRST_USE_HOURLY: '2' }, async () => {
    externalCalls++
    throw Error('External mail is forbidden in this fixture')
  }))
  await check()
  assert.deepEqual((await client.query('SELECT kind FROM hosted_abuse_alerts')).rows, [{ kind: 'signup_spike' }])
  await check()
  assert.equal((await client.query('SELECT count(*)::int AS n FROM hosted_abuse_alerts')).rows[0].n, 1)
  assert.equal(externalCalls, 0)
})
