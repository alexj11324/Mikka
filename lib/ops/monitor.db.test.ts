import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl } from '../../tests/support/workspace-admin-db'
import { collectOperationalSignals } from './monitor'
import { MAX_WAKE_ATTEMPTS } from '../coordinator/wake-recovery'
import { repairDrillFaults } from '../../scripts/ops/drill-state.mjs'
import { CLEANUP_DUE_SQL } from '../subscription-acquire-expiry'
import { databaseSignals } from '../../scripts/ops/monitor.mjs'

test('overdue secret cleanup follows ordinary worker ownership and connection references with a five-minute grace', { skip: !dbUrl }, async t => {
  const admin = new Pool({ connectionString: dbUrl }), schema = `ops_cleanup_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}`, max: 5 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() })
  for (const table of ['coordinator_events', 'agent_runs', 'operation_ledger', 'byos_secret_artifacts', 'byos_connections', 'schedule_occurrences', 'account_deletion_jobs', 'byos_enrollment_sources', 'byos_enrollment_transfers'])
    await pool.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`)
  const at = new Date()
  const count = async (expected: number, workerCount = expected) => {
    const signals = await databaseSignals(pool, at)
    assert.equal(signals.databaseAvailable, 1)
    assert.equal(signals.overdueSecretCleanup, expected)
    assert.equal((await pool.query(CLEANUP_DUE_SQL)).rowCount, workerCount)
  }
  const artifact = async (owner: string, workspace = 'fixture', minutes = 10, publishedMinutes: number | null = null) => {
    const connection = randomUUID(), name = `orphan-${randomUUID()}`
    await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state) VALUES($1,$2,$3,'codex','disconnected')`, [connection, owner, workspace])
    await pool.query(`INSERT INTO byos_secret_artifacts(name,"connectionId","ownerId","workspaceId",provider,kind,"notBefore","publishedAt")
      VALUES($1,$2,$3,$4,'codex','oauth',$5,$6)`, [name, connection, owner, workspace, new Date(at.getTime() - minutes * 60_000), publishedMinutes === null ? null : new Date(at.getTime() - publishedMinutes * 60_000)])
    return { connection, name }
  }
  await count(0)
  await artifact('deleting')
  const job = randomUUID()
  await pool.query(`INSERT INTO account_deletion_jobs(id,"subjectUserId","subjectEmailHash",stage,plan)
    VALUES($1,'deleting',$2,'external_pending',$3)`, [job, 'a'.repeat(64), JSON.stringify({ solo: ['solo-workspace'] })])
  await count(0)
  const ordinary = await artifact('ordinary')
  await count(1)
  await artifact('other-owner', 'SOLO-WORKSPACE')
  await count(1)
  const otherConnection = randomUUID()
  await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,"secretName","secretDigest") VALUES($1,'other','fixture','codex','disconnected',$2,$3)`, [otherConnection, ordinary.name, 'a'.repeat(64)])
  await count(1)
  await pool.query(`UPDATE byos_connections SET "stagedSecretName"=$2,"stagedDigest"=$3 WHERE id=$1`, [ordinary.connection, ordinary.name, 'a'.repeat(64)])
  await count(0)
  await pool.query(`UPDATE byos_connections SET "stagedSecretName"=NULL,"stagedDigest"=NULL WHERE id=$1`, [ordinary.connection])
  await artifact('recent', 'fixture', 2)
  await artifact('future', 'fixture', -10)
  await count(1, 2)
  await artifact('published-overdue', 'fixture', -10, 10)
  await artifact('published-recent', 'fixture', -10, 2)
  await count(2, 4)
  await pool.query(`UPDATE account_deletion_jobs SET stage='completed' WHERE id=$1`, [job])
  await count(4, 6)
  await pool.query(`UPDATE account_deletion_jobs SET stage='cancelled' WHERE id=$1`, [job])
  await count(4, 6)
  await pool.query(`UPDATE byos_secret_artifacts SET "deletedAt"=$1`, [at])
  await count(0)
})

test('open account deletions older than 24 hours alert and resolve without exposing job data', { skip: !dbUrl }, async t => {
  const admin = new Pool({ connectionString: dbUrl }), schema = `ops_deletion_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema},public` })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() })
  for (const table of ['coordinator_events', 'agent_runs', 'operation_ledger', 'byos_secret_artifacts', 'byos_connections', 'schedule_occurrences', 'account_deletion_jobs'])
    await pool.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`)
  await pool.query(await readFile(new URL('../../drizzle/20261031050736_ops_monitor_observations.sql', import.meta.url), 'utf8'))
  const server = createServer((_request, response) => { response.writeHead(204); response.end() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const sink = `http://127.0.0.1:${address.port}/alerts`
  const now = new Date(), privateMarker = `private-${randomUUID()}`
  assert.equal((await collectOperationalSignals(pool, { now: new Date(now.getTime() - 2), sink })).signals.overdueAccountDeletion, 0)
  for (const [stage, hours] of [['external_pending', 25], ['requested', 26], ['storage_pending', 27], ['completed', 30], ['cancelled', 30], ['external_pending', 24], ['external_pending', 1]] as const)
    await pool.query(`INSERT INTO account_deletion_jobs(id,"subjectUserId","subjectEmailHash",stage,"requestedAt") VALUES($1,$2,repeat('0',64),$3,$4::timestamptz-$5*interval '1 hour')`, [randomUUID(), privateMarker, stage, now, hours])
  const fired = await collectOperationalSignals(pool, { now: new Date(now.getTime() - 1), sink })
  assert.equal(fired.signals.overdueAccountDeletion, 3)
  assert.deepEqual(fired.transitions.map(event => [event.id, event.state]), [['overdueAccountDeletion', 'firing']])
  assert.ok(!JSON.stringify(fired).includes(privateMarker))
  await pool.query(`UPDATE account_deletion_jobs SET stage='completed' WHERE "requestedAt"<$1::timestamptz-interval '24 hours'`, [now])
  const recovered = await collectOperationalSignals(pool, { now, sink })
  assert.equal(recovered.signals.overdueAccountDeletion, 0)
  assert.deepEqual(recovered.transitions.map(event => [event.id, event.state]), [['overdueAccountDeletion', 'resolved']])
})

test('minute collector persists real SQL signals without a sink and keeps delivery retries separate from incident deduplication', { skip: !dbUrl }, async t => {
  const admin = new Pool({ connectionString: dbUrl }), schema = `ops_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema},public`, max: 5 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() })
  for (const table of ['coordinator_events', 'agent_runs', 'operation_ledger', 'byos_secret_artifacts', 'byos_connections', 'schedule_occurrences', 'account_deletion_jobs'])
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
  // The aggregate statement fails while its observation table and loopback sink remain available.
  await pool.query('ALTER TABLE coordinator_events RENAME COLUMN "deliveredAt" TO hidden_delivered_at')
  result = await collectOperationalSignals(pool, { sink })
  assert.deepEqual(result.transitions.map(event => [event.id, event.state]), [['database-unavailable', 'firing']])
  assert.equal(delivered, before + 1, 'no recovery notification for the unobserved stale wake')
  await pool.query('ALTER TABLE coordinator_events RENAME COLUMN hidden_delivered_at TO "deliveredAt"')
  await pool.query('UPDATE coordinator_events SET "deliveredAt"=now()')
  result = await collectOperationalSignals(pool, { sink })
  assert.deepEqual(result.transitions.map(event => [event.id, event.state]).sort(), [['database-unavailable', 'resolved'], ['staleWake', 'resolved']])
  assert.equal(result.notificationStatus, 'delivered')
  assert.equal((await pool.query('SELECT count(*)::int n FROM ops_monitor_observations')).rows[0].n, 7)
})

test('an exhausted wake is its own terminal signal and no longer holds staleWake firing', { skip: !dbUrl }, async t => {
  const admin = new Pool({ connectionString: dbUrl }), schema = `ops_exhausted_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema},public`, max: 5 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() })
  for (const table of ['coordinator_events', 'agent_runs', 'operation_ledger', 'byos_secret_artifacts', 'byos_connections', 'schedule_occurrences'])
    await pool.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`)
  await pool.query(await readFile(new URL('../../drizzle/20261031050736_ops_monitor_observations.sql', import.meta.url), 'utf8'))
  await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,"createdAt","wakeAttempts","wakeLastError") VALUES
    (gen_random_uuid(),'ops-fixture','run_finished',gen_random_uuid()::text,'{}',now()-interval '10 minutes',$1,'wake_exhausted')`, [MAX_WAKE_ATTEMPTS])
  const exhausted = await collectOperationalSignals(pool)
  assert.equal(exhausted.signals.staleWake, 0); assert.equal(exhausted.signals.exhaustedWake, 1)
  assert.deepEqual(exhausted.alerts, [])
  await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,"createdAt","wakeAttempts") VALUES
    (gen_random_uuid(),'ops-fixture','run_finished',gen_random_uuid()::text,'{}',now()-interval '10 minutes',$1)`, [MAX_WAKE_ATTEMPTS - 1])
  const stale = await collectOperationalSignals(pool)
  assert.equal(stale.signals.staleWake, 1); assert.equal(stale.signals.exhaustedWake, 1)
  assert.deepEqual(stale.alerts.map((alert: { id: string }) => alert.id), ['staleWake'])
})

test('fault matrix preserves failed SLO history while live wake, lease, uncertainty and cleanup signals recover', { skip: !dbUrl }, async t => {
  const admin = new Pool({ connectionString: dbUrl }), schema = `ops_matrix_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema},public`, max: 5 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() })
  for (const table of ['coordinator_events', 'agent_runs', 'operation_ledger', 'byos_secret_artifacts', 'byos_connections', 'schedule_occurrences', 'account_deletion_jobs'])
    await pool.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`)
  await pool.query(await readFile(new URL('../../drizzle/20261031050736_ops_monitor_observations.sql', import.meta.url), 'utf8'))
  const at = new Date(), privateMarker = `private-${randomUUID()}`, run = randomUUID(), failedRun = randomUUID(), connection = randomUUID()
  await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,"createdAt") VALUES
    (gen_random_uuid(),$1,'user_message',gen_random_uuid()::text,'{}',NULL,$2::timestamptz-interval '10 minutes'),
    (gen_random_uuid(),$1,'user_message',gen_random_uuid()::text,'{}','background',$2::timestamptz-interval '10 minutes')`, [privateMarker, at])
  await pool.query(`INSERT INTO agent_runs(id,"userId","agentId",status,"createdAt","startedAt","leaseExpiresAt","finishedAt") VALUES
    ($1,$3,gen_random_uuid(),'running',$4::timestamptz-interval '8 minutes',NULL,$4::timestamptz-interval '5 minutes',NULL),
    ($2,$3,gen_random_uuid(),'failed',$4::timestamptz-interval '8 minutes',NULL,$4::timestamptz-interval '5 minutes',$4::timestamptz-interval '7 minutes'),
    ($5,$3,gen_random_uuid(),'succeeded',$4::timestamptz-interval '8 minutes',$4::timestamptz-interval '8 minutes'+interval '1 second',NULL,$4::timestamptz-interval '7 minutes')`, [run, failedRun, privateMarker, at, randomUUID()])
  const effectIds: string[] = []
  for (const status of ['uncertain', 'executing', 'reserved']) {
    const id = randomUUID(); if (status !== 'reserved') effectIds.push(id)
    await pool.query(`INSERT INTO operation_ledger("operationId","ownerId","workspaceId",binding,"idempotencyKey",status,"attemptToken","updatedAt")
      VALUES($5,$1,'fixture','{}',gen_random_uuid()::text,$2,$3,$4::timestamptz-interval '10 minutes')`, [privateMarker, status, status === 'reserved' ? null : randomUUID(), at, id])
  }
  const liveSecret = `${privateMarker}-live`
  await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject")
    VALUES($1,$2,'fixture','codex','connected',$3,$4,$2)`, [connection, privateMarker, liveSecret, 'a'.repeat(64)])
  for (const [name, notBefore, deleted] of [[`${privateMarker}-orphan`, -600_000, false], [liveSecret, -600_000, false], [`${privateMarker}-future`, 3_600_000, false], [`${privateMarker}-deleted`, -600_000, true]] as const)
    await pool.query(`INSERT INTO byos_secret_artifacts(name,"connectionId","ownerId","workspaceId",provider,kind,"notBefore","deletedAt")
      VALUES($1,$2,$3,'fixture','codex','access',$4,$5)`, [name, connection, privateMarker, new Date(at.getTime() + notBefore), deleted ? at : null])
  for (const [status, decision, finished] of [['pending', 'execute', false], ['succeeded', 'execute', true], ['failed', 'execute', false], ['skipped', 'skip', false]] as const)
    await pool.query(`INSERT INTO schedule_occurrences(id,schedule_id,version,due_at,definition,status,execution_decision,operation_id,next_retry_at,finished_at)
      VALUES(gen_random_uuid(),gen_random_uuid(),1,$4::timestamptz-interval '8 minutes','{}',$1,$2,gen_random_uuid(),$4,CASE WHEN $3::boolean THEN $4::timestamptz-interval '7 minutes' END)`, [status, decision, finished, at])
  const received: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    received.push(body); response.writeHead(204); response.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const sink = `http://127.0.0.1:${address.port}/internal-alerts`
  const fired = await collectOperationalSignals(pool, { sink, now: at })
  assert.deepEqual(fired.signals, { databaseAvailable: 1, staleWake: 1, exhaustedWake: 0, expiredRunLease: 1, uncertainEffect: 1, staleEffect: 1, overdueAccountDeletion: 0, overdueSecretCleanup: 1, dueTotal: 3, dueSuccessful: 1, dispatchTotal: 3, dispatchStarted: 1 })
  assert.equal(fired.notificationStatus, 'delivered'); assert.equal(received.length, 7)
  await collectOperationalSignals(pool, { sink, now: new Date(at.getTime() + 1) }); assert.equal(received.length, 7)

  // These rows represent injected effects which never called a provider; no real
  // unknown operation can be cleared without authoritative no-effect evidence.
  await repairDrillFaults(pool, { ownerId: privateMarker, runId: run, effectIds })
  await pool.query('UPDATE byos_secret_artifacts SET "deletedAt"=$1 WHERE name=$2', [at, `${privateMarker}-orphan`])
  const repaired = await collectOperationalSignals(pool, { sink, now: new Date(at.getTime() + 2) })
  assert.deepEqual(repaired.alerts.map((alert: { id: string }) => alert.id), ['due-on-time', 'dispatch-start'])
  assert.deepEqual(repaired.transitions.filter(event => event.state === 'resolved').map(event => event.id).sort(), ['expiredRunLease', 'overdueSecretCleanup', 'staleEffect', 'staleWake', 'uncertainEffect'].sort())
  assert.equal(repaired.signals.dispatchTotal, 3); assert.equal(repaired.signals.dispatchStarted, 1)
  assert.equal(repaired.signals.dueTotal, 3); assert.equal(repaired.signals.dueSuccessful, 1)
  assert.equal((await pool.query('SELECT "startedAt" FROM agent_runs WHERE id=$1', [failedRun])).rows[0].startedAt, null)
  const stopped = (await pool.query('SELECT status,"startedAt" FROM agent_runs WHERE id=$1', [run])).rows[0]
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.startedAt, null)
  assert.equal((await pool.query("SELECT count(*)::int n FROM schedule_occurrences WHERE status='failed'")).rows[0].n, 1)
  // Read a later window explicitly; do not rewrite old failed rows to fabricate
  // recovery. This is deterministic window testing, not a wall-clock SLA claim.
  const emptyWindow = new Date(at.getTime() + 20 * 60_000)
  const afterWindow = await collectOperationalSignals(pool, { sink, now: emptyWindow })
  assert.deepEqual(afterWindow.alerts, [])
  assert.deepEqual(afterWindow.transitions, [], 'an empty denominator cannot resolve either incident')
  assert.equal(received.length, 12, 'only the five observed recoveries have been delivered')

  // Only new on-time work makes the two ratios observable and healthy again.
  await pool.query(`INSERT INTO schedule_occurrences(id,schedule_id,version,due_at,definition,status,execution_decision,operation_id,next_retry_at,finished_at)
    VALUES(gen_random_uuid(),gen_random_uuid(),1,$1,'{}','succeeded','execute',gen_random_uuid(),$1,$1)`, [emptyWindow])
  await pool.query(`INSERT INTO agent_runs(id,"userId","agentId",status,"createdAt","startedAt","finishedAt")
    VALUES(gen_random_uuid(),$1,gen_random_uuid(),'succeeded',$2,$2,$2)`, [privateMarker, emptyWindow])
  const observed = await collectOperationalSignals(pool, { sink, now: new Date(emptyWindow.getTime() + 3 * 60_000) })
  assert.deepEqual(observed.transitions.map(event => [event.id, event.state]), [['due-on-time', 'resolved'], ['dispatch-start', 'resolved']])
  assert.equal(received.length, 14)
  assert.ok(!JSON.stringify([fired, repaired, afterWindow, observed, received]).includes(privateMarker))
})
