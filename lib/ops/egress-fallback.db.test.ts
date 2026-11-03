import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl } from '../../tests/support/workspace-admin-db'
import { collectProviderEgress } from './egress-fallback'
import { collectOperationalSignals } from './monitor'

test('durable fallback survives concurrent ticks, respects due/retry times and never holds the operational lock across network calls', { skip: !dbUrl }, async t => {
  const admin = new Pool({ connectionString: dbUrl }), schema = `egress_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema},public`, max: 5 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() })
  await pool.query(await readFile(new URL('../../drizzle/20261031050736_ops_monitor_observations.sql', import.meta.url), 'utf8'))
  for (const table of ['coordinator_events', 'agent_runs', 'operation_ledger', 'byos_secret_artifacts', 'byos_connections', 'schedule_occurrences'])
    await pool.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`)
  let at = Date.now(), calls = 0
  const options = { now: () => at, collect: async () => { calls++ } }
  assert.deepEqual(await collectProviderEgress(pool, options), { status: 'not_due' })
  const insert = () => pool.query(`INSERT INTO ops_monitor_observations(id,signals,alerts,transitions,state,"notificationStatus")
    VALUES(gen_random_uuid(),'{}','[]','[]','{"unrelated":{"active":true}}','not_configured')`)
  await insert()
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => collectProviderEgress(pool, options)))
  assert.equal(calls, 1); assert.equal(concurrent.filter(r => r.status === 'collected').length, 1)
  at += 899_999
  assert.equal((await collectProviderEgress(pool, options)).status, 'not_due')
  at++
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  const running = collectProviderEgress(pool, { now: () => at, collect: async () => { entered(); await pending } })
  await started
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    assert.equal((await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('mikka-ops-monitor',0)) AS free")).rows[0].free, true)
    // Simulate the ordinary monitor recording a new observation while the HTTP
    // provider is pending, as its existing transaction copies the prior state.
    await client.query(`INSERT INTO ops_monitor_observations(id,"observedAt",signals,alerts,transitions,state,"notificationStatus")
      SELECT gen_random_uuid(),"observedAt"+interval '1 second',signals,alerts,transitions,state,'not_configured'
      FROM ops_monitor_observations ORDER BY "observedAt" DESC,id DESC LIMIT 1`)
    await client.query('COMMIT')
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
  assert.equal((await collectProviderEgress(pool, options)).status, 'not_due')
  release(); assert.equal((await running).status, 'collected')
  const state = (await pool.query('SELECT state FROM ops_monitor_observations ORDER BY "observedAt" DESC,id DESC LIMIT 1')).rows[0].state
  assert.equal(state.unrelated.active, true); assert.equal(state.__providerEgressCollector.lastSucceededAt, at)
  await pool.query(`UPDATE ops_monitor_observations SET state=jsonb_set(state,'{__providerEgressCollector,active}','true')`)
  const operational = await collectOperationalSignals(pool)
  assert.ok(operational.transitions.every(event => event.id !== '__providerEgressCollector'))
  assert.ok(operational.alerts.every((alert: { id: string }) => alert.id !== '__providerEgressCollector'))
  assert.equal((await pool.query('SELECT state FROM ops_monitor_observations ORDER BY "observedAt" DESC,id DESC LIMIT 1')).rows[0].state.__providerEgressCollector.lastSucceededAt, at)
  at += 900_000
  const fail = { now: () => at, collect: async () => { throw Error('private-marker') } }
  assert.deepEqual(await collectProviderEgress(pool, fail), { status: 'failed' })
  assert.equal((await collectProviderEgress(pool, options)).status, 'not_due')
  at += 60_000
  assert.equal((await collectProviderEgress(pool, options)).status, 'collected')
  assert.ok(!JSON.stringify((await pool.query('SELECT state FROM ops_monitor_observations')).rows).includes('private-marker'))
})
