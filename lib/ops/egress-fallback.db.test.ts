import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
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
  let at = Date.UTC(2026, 10, 4, 12, 0), calls = 0
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
  const originalFetch = globalThis.fetch
  let deliveries = 0
  globalThis.fetch = async () => { deliveries++; return new Response(null, { status: 204 }) }
  let operational: Awaited<ReturnType<typeof collectOperationalSignals>>
  try { operational = await collectOperationalSignals(pool, { sink: 'http://127.0.0.1:1/alerts' }) }
  finally { globalThis.fetch = originalFetch }
  assert.equal(deliveries, 0, 'reserved collector metadata cannot produce an operational notification')
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

async function observationPool(t: TestContext) {
  const admin = new Pool({ connectionString: dbUrl }), schema = `egress_quarter_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema},public`, max: 5 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() })
  await pool.query(await readFile(new URL('../../drizzle/20261031050736_ops_monitor_observations.sql', import.meta.url), 'utf8'))
  await pool.query(`INSERT INTO ops_monitor_observations(id,signals,alerts,transitions,state,"notificationStatus")
    VALUES(gen_random_uuid(),'{}','[]','[]','{"unrelated":{"active":true}}','not_configured')`)
  return pool
}

const collectorState = async (pool: Pool) => (await pool.query('SELECT state FROM ops_monitor_observations ORDER BY "observedAt" DESC,id DESC LIMIT 1')).rows[0].state.__providerEgressCollector

test('nonzero collection time retains the next UTC quarter and old minute callers cannot collect twice in that quarter', { skip: !dbUrl }, async t => {
  const pool = await observationPool(t)
  const start = Date.UTC(2026, 10, 4, 12, 0)
  let at = start, calls = 0
  const options = { now: () => at, collect: async () => { calls++; at += 4_000 } }
  assert.equal((await collectProviderEgress(pool, options)).status, 'collected')
  assert.equal((await collectorState(pool)).nextAttemptAt, start + 900_000)
  assert.equal((await collectorState(pool)).lastSucceededAt, start + 4_000)
  for (let minute = 1; minute < 15; minute++) {
    at = start + minute * 60_000
    assert.equal((await collectProviderEgress(pool, options)).status, 'not_due')
  }
  at = start + 899_999
  assert.equal((await collectProviderEgress(pool, options)).status, 'not_due')
  at++
  assert.equal((await collectProviderEgress(pool, options)).status, 'collected')
  assert.equal(calls, 2)
  assert.equal((await collectorState(pool)).nextAttemptAt, start + 1_800_000)
  assert.equal((await collectProviderEgress(pool, options)).status, 'not_due')
})

test('a collection crossing a UTC quarter does not consume the next quarter', { skip: !dbUrl }, async t => {
  const pool = await observationPool(t)
  const boundary = Date.UTC(2026, 10, 4, 12, 15)
  let at = boundary - 1_000, calls = 0
  const options = { now: () => at, collect: async () => { calls++; at += 4_000 } }
  assert.equal((await collectProviderEgress(pool, options)).status, 'collected')
  assert.equal((await collectorState(pool)).nextAttemptAt, boundary)
  assert.equal((await collectProviderEgress(pool, options)).status, 'collected')
  assert.equal((await collectProviderEgress(pool, options)).status, 'not_due')
  assert.equal(calls, 2)
  assert.equal((await collectorState(pool)).nextAttemptAt, boundary + 900_000)
})

test('a quarter boundary cannot bypass a live claim and an expired claimant cannot overwrite its replacement', { skip: !dbUrl }, async t => {
  const pool = await observationPool(t)
  const start = Date.UTC(2026, 10, 4, 12, 14)
  let at = start, release!: () => void, entered!: () => void, calls = 0
  const pending = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const old = collectProviderEgress(pool, { now: () => at, collect: async () => { entered(); await pending } })
  await started
  const first = await collectorState(pool)
  assert.equal(first.nextAttemptAt, start + 120_000)
  const options = { now: () => at, collect: async () => { calls++; at += 4_000 } }
  at = start + 60_000
  assert.equal((await collectProviderEgress(pool, options)).status, 'not_due')
  at = start + 119_999
  assert.equal((await collectProviderEgress(pool, options)).status, 'not_due')
  at++
  assert.equal((await collectProviderEgress(pool, options)).status, 'collected')
  const replacement = await collectorState(pool)
  assert.notEqual(replacement.claim, first.claim)
  at++
  release(); await old
  assert.deepEqual(await collectorState(pool), replacement)
  assert.equal(replacement.nextAttemptAt, Date.UTC(2026, 10, 4, 12, 30))
  assert.equal((await collectProviderEgress(pool, options)).status, 'not_due')
  assert.equal(calls, 1)
})

test('failure retry remains sixty seconds after completion even across a UTC quarter', { skip: !dbUrl }, async t => {
  const pool = await observationPool(t)
  const boundary = Date.UTC(2026, 10, 4, 12, 15)
  let at = boundary - 2_000, calls = 0
  assert.equal((await collectProviderEgress(pool, { now: () => at, collect: async () => { at += 7_000; throw Error('private-marker') } })).status, 'failed')
  assert.equal((await collectorState(pool)).nextAttemptAt, boundary + 65_000)
  const options = { now: () => at, collect: async () => { calls++ } }
  at = boundary + 64_999
  assert.equal((await collectProviderEgress(pool, options)).status, 'not_due')
  at++
  assert.equal((await collectProviderEgress(pool, options)).status, 'collected')
  assert.equal(calls, 1)
  assert.equal((await collectorState(pool)).nextAttemptAt, boundary + 900_000)
  assert.ok(!JSON.stringify(await collectorState(pool)).includes('private-marker'))
})
