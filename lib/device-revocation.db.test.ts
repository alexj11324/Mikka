import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { createRequestDatabaseScope } from './db/request-scope'
import { deviceScopedPool, withDeviceDatabaseAuthority, isDeviceAuthorityRevoked } from './db/device-scope'
import { revokeDeviceCredential } from './device-revocation'
import { POST as reportEvents } from '../app/v1/runs/[runId]/events/route'
import { GET as commands } from '../app/v1/devices/[deviceId]/commands/route'

const url = process.env.E2E_DATABASE_URL
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_e2e')) throw new Error('An isolated loopback *_e2e database is required')
const schema = `revoke178_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: url, max: 8 })
const target = new URL(url)
target.searchParams.set('options', `-c search_path=${schema}`)
const raw = new Pool({ connectionString: target.toString(), max: 8 })
const scope = createRequestDatabaseScope(target.toString())
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`)
  for (const table of ['devices', 'device_tokens', 'device_token_devices', 'agents', 'agent_runs', 'run_tokens', 'run_chunks', 'run_messages']) {
    await raw.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING INDEXES)`)
  }
  await raw.query(await readFile(new URL('../drizzle/20261030203814_daemon_credential_revocation.sql', import.meta.url), 'utf8'))
})
after(async () => { await scope.close(); await raw.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })

async function fixture(existingOwner?: string) {
  const owner = existingOwner ?? `revoke-${randomUUID()}`, device = randomUUID(), agent = randomUUID(), run = randomUUID(), tokenId = randomUUID(), workerId = randomUUID()
  const token = `orv_${randomBytes(32).toString('base64url')}`
  await raw.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,$3)', [device, owner, 'Revocation test device'])
  await raw.query('INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,$3,$4,$5)', [agent, owner, 'codex', `Revocation test agent ${agent}`, device])
  await raw.query('INSERT INTO device_tokens(id,"userId","tokenHash","lastUsedAt") VALUES($1,$2,$3,now())', [tokenId, owner, createHash('sha256').update(token).digest('hex')])
  await raw.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId","deviceTokenId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,$5,'running',now()+interval '90 seconds')`, [run, owner, agent, device, tokenId])
  await raw.query(`INSERT INTO run_tokens(id,"userId","runId","tokenHash","expiresAt") VALUES($1,$2,$3,$4,now()+interval '1 hour')`, [workerId, owner, run, createHash('sha256').update(randomBytes(32)).digest('hex')])
  return { owner, device, agent, run, tokenId, workerId, token }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function state(f: Fixture) {
  return (await raw.query(`SELECT t."revokedAt",t."revokedBy",r."stopRequestedAt",r."leaseExpiresAt",w."revokedAt" AS "workerRevokedAt",(SELECT count(*)::int FROM device_credential_revocations WHERE "tokenId"=$1) AS receipts
    FROM device_tokens t JOIN agent_runs r ON r."deviceTokenId"=t.id JOIN run_tokens w ON w."runId"=r.id WHERE t.id=$1`, [f.tokenId])).rows[0]
}
function caller(f: Fixture) { return { userId: f.owner, tokenId: f.tokenId } }
async function report(f: Fixture) {
  return scope.run(() => reportEvents(new Request(`http://127.0.0.1/mikka/v1/runs/${f.run}/events`, {
    method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fromSeq: 1, chunks: [{ type: 'text-delta', id: 'part', delta: 'controlled report' }] }),
  }), { params: Promise.resolve({ runId: f.run }) }))
}

test('owner revoke stops attributed work, revokes worker access, records once and preserves sibling credentials', async () => {
  const f = await fixture(), sibling = await fixture(f.owner)
  assert.equal(await revokeDeviceCredential(raw, 'not-owner', f.tokenId), null)
  assert.equal((await state(f)).revokedAt, null)
  const receipt = await revokeDeviceCredential(raw, f.owner, f.tokenId)
  assert.equal(receipt?.revokedBy, f.owner)
  assert.deepEqual(await revokeDeviceCredential(raw, f.owner, f.tokenId), receipt)
  const revoked = await state(f)
  assert.ok(revoked.revokedAt && revoked.stopRequestedAt && revoked.workerRevokedAt)
  assert.equal(revoked.receipts, 1)
  assert.ok(revoked.leaseExpiresAt.getTime() <= Date.now())
  assert.equal((await state(sibling)).revokedAt, null)
})

test('a receipt write fault rolls token, stop, lease and worker revocation back atomically', async () => {
  const f = await fixture()
  const initial = await state(f)
  const name = `fault_${randomUUID().replaceAll('-', '')}`
  await raw.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tokenId"='${f.tokenId}'::uuid THEN RAISE EXCEPTION 'controlled receipt fault'; END IF; RETURN NEW; END $$`)
  await raw.query(`CREATE TRIGGER ${name} BEFORE INSERT ON device_credential_revocations FOR EACH ROW EXECUTE FUNCTION ${name}()`)
  await assert.rejects(revokeDeviceCredential(raw, f.owner, f.tokenId), /controlled receipt fault/)
  assert.deepEqual(await state(f), initial)
  await raw.query(`DROP TRIGGER ${name} ON device_credential_revocations`)
  assert.ok(await revokeDeviceCredential(raw, f.owner, f.tokenId))
})

test('a revocation waits for the admitted writer transaction, and later raw/ORM admissions all refuse', async () => {
  const f = await fixture()
  let release!: () => void
  let admitted!: () => void
  const ready = new Promise<void>(resolve => { admitted = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const write = withDeviceDatabaseAuthority(caller(f), async () => {
    const client = await deviceScopedPool(raw).connect()
    try {
      await client.query('BEGIN')
      await client.query('UPDATE devices SET name=$1 WHERE id=$2', ['admitted change', f.device])
      admitted(); await gate
      await client.query('COMMIT')
    } finally { client.release() }
  })
  await ready
  let completed = false
  const revoking = revokeDeviceCredential(raw, f.owner, f.tokenId).then(value => { completed = true; return value })
  await delay(75)
  assert.equal(completed, false)
  release(); await write; await revoking
  await withDeviceDatabaseAuthority(caller(f), async () => {
    const guarded = deviceScopedPool(raw)
    await assert.rejects(guarded.query('UPDATE devices SET name=$1 WHERE id=$2', ['must not land', f.device]), isDeviceAuthorityRevoked)
    for (let i = 0; i < 10; i++) await assert.rejects(drizzle(guarded).transaction(tx => tx.execute(sql`SELECT 1`)), isDeviceAuthorityRevoked)
  })
  assert.equal((await raw.query('SELECT name FROM devices WHERE id=$1', [f.device])).rows[0].name, 'admitted change')
})

test('the actual event route accepts before revoke and rejects the old token after a fresh request scope', async () => {
  const f = await fixture()
  assert.equal((await report(f)).status, 200)
  await revokeDeviceCredential(raw, f.owner, f.tokenId)
  assert.equal((await report(f)).status, 401)
  assert.equal((await raw.query('SELECT count(*)::int n FROM run_chunks WHERE "runId"=$1', [f.run])).rows[0].n, 1)
  await raw.query('UPDATE devices SET enabled=true WHERE id=$1', [f.device])
  assert.equal((await report(f)).status, 401)
})

test('revocation while the real event handler waits for its body prevents the later write', async () => {
  const f = await fixture()
  let body!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller } })
  body.enqueue(new TextEncoder().encode('{"fromSeq":1,"chunks":'))
  const request = new Request(`http://127.0.0.1/mikka/v1/runs/${f.run}/events`, {
    method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: stream, duplex: 'half',
  } as RequestInit & { duplex: string })
  const writing = scope.run(() => reportEvents(request, { params: Promise.resolve({ runId: f.run }) }))
  await delay(100)
  await revokeDeviceCredential(raw, f.owner, f.tokenId)
  body.enqueue(new TextEncoder().encode('[{"type":"text-delta","id":"part","delta":"must not persist"}]}'))
  body.close()
  assert.equal((await writing).status, 401)
  assert.equal((await raw.query('SELECT count(*)::int n FROM run_chunks WHERE "runId"=$1', [f.run])).rows[0].n, 0)
})

test('terminating an admitted write connection rolls back both the write and authority lock', async () => {
  const f = await fixture()
  let release!: () => void
  let admitted!: (pid: number) => void
  const ready = new Promise<number>(resolve => { admitted = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const writer = withDeviceDatabaseAuthority(caller(f), async () => {
    const client = await deviceScopedPool(raw).connect()
    try {
      await client.query('BEGIN')
      await client.query('UPDATE devices SET name=$1 WHERE id=$2', ['must roll back', f.device])
      admitted((await client.query('SELECT pg_backend_pid() pid')).rows[0].pid)
      await gate
      await assert.rejects(client.query('COMMIT'))
    } finally { client.release() }
  })
  const pid = await ready
  await admin.query('SELECT pg_terminate_backend($1)', [pid])
  release(); await writer
  assert.ok(await revokeDeviceCredential(raw, f.owner, f.tokenId))
  assert.equal((await raw.query('SELECT name FROM devices WHERE id=$1', [f.device])).rows[0].name, 'Revocation test device')
})

test('a long poll loses token authority within its one-second database polling interval', async () => {
  const f = await fixture()
  const started = Date.now()
  const poll = scope.run(() => commands(new Request(`http://127.0.0.1/mikka/v1/devices/${f.device}/commands?wait=20`, {
    headers: { authorization: `Bearer ${f.token}` },
  }), { params: Promise.resolve({ deviceId: f.device }) }))
  await delay(150)
  await revokeDeviceCredential(raw, f.owner, f.tokenId)
  assert.equal((await poll).status, 401)
  assert.ok(Date.now() - started < 3000)
})
