import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl } from '../../tests/support/workspace-admin-db'
import { collectOperationalSignals } from './monitor'

test('minute collector persists real SQL signals without a sink and keeps delivery retries separate from incident deduplication', { skip: !dbUrl }, async t => {
  const admin = new Pool({ connectionString: dbUrl }), schema = `ops_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema},public`, max: 5 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() })
  for (const table of ['coordinator_events', 'agent_runs', 'operation_ledger', 'byos_secret_artifacts', 'byos_connections', 'schedule_occurrences'])
    await pool.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`)
  await pool.query(await readFile(new URL('../../drizzle/20261031050736_ops_monitor_observations.sql', import.meta.url), 'utf8'))
  let result = await collectOperationalSignals(pool)
  assert.equal(result.notificationStatus, 'not_configured'); assert.equal(result.persisted, true); assert.equal(result.signals.databaseAvailable, 1)
  await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,"createdAt") VALUES(gen_random_uuid(),'ops-fixture','user_message',gen_random_uuid()::text,'{}',now()-interval '10 minutes')`)
  let refuse = true, delivered = 0
  const server = createServer((_request, response) => { delivered++; response.writeHead(refuse ? 503 : 204); response.end() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const sink = `http://127.0.0.1:${address.port}/alerts`
  result = await collectOperationalSignals(pool, { sink })
  assert.equal(result.notificationStatus, 'failed'); assert.equal(result.signals.staleWake, 1)
  assert.deepEqual(result.transitions.map(event => event.state), ['firing'])
  result = await collectOperationalSignals(pool, { sink })
  assert.equal(result.notificationStatus, 'failed'); assert.equal(result.transitions.length, 0)
  refuse = false; result = await collectOperationalSignals(pool, { sink })
  assert.equal(result.notificationStatus, 'delivered')
  const before = delivered
  await collectOperationalSignals(pool, { sink }); assert.equal(delivered, before)
  await pool.query('UPDATE coordinator_events SET "deliveredAt"=now()')
  result = await collectOperationalSignals(pool, { sink })
  assert.deepEqual(result.transitions.map(event => event.state), ['resolved'])
  assert.equal(result.notificationStatus, 'delivered')
  assert.equal((await pool.query('SELECT count(*)::int n FROM ops_monitor_observations')).rows[0].n, 6)
})
