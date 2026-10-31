import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createRequestDatabaseScope } from './db/request-scope'
import { mintDeviceEnrollment, consumeDeviceEnrollment } from './device-enrollment'
import { authenticateDevice, hashDeviceToken } from './device-link'
import { enqueueDeviceCommand, pendingDeviceCommands } from './device-management'
import { removeOwnedDevice } from './device-removal'

const url = process.env.E2E_DATABASE_URL
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_e2e')) throw new Error('An isolated loopback *_e2e database is required')
const schema = `device491_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: url })
const target = new URL(url)
target.searchParams.set('options', `-c search_path=${schema}`)
const scope = createRequestDatabaseScope(target.toString())
const run = <T>(fn: () => T) => scope.run(fn)
before(async () => {
  // Device heartbeat uses bearer authentication; unrelated human-session setup is not used here.
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => null } } } })
  await admin.query(`CREATE SCHEMA ${schema}`)
  await run(async () => {
    const { pool } = await import('./db')
    await pool.query(`CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text NOT NULL,kind text DEFAULT 'local',"removedAt" timestamptz,enabled boolean DEFAULT true,"lastSeenAt" timestamptz,"updatedAt" timestamptz);
    CREATE TABLE device_tokens (id uuid PRIMARY KEY,"userId" text NOT NULL,"tokenHash" text NOT NULL,name text,"lastUsedAt" timestamptz,"revokedAt" timestamptz,"boundDeviceId" uuid,"boundWorkspaceId" uuid,"expiresAt" timestamptz);
    CREATE TABLE device_token_devices ("tokenId" uuid,"deviceId" uuid,"userId" text,PRIMARY KEY("tokenId","deviceId"));
    CREATE TABLE agents (id uuid PRIMARY KEY,"userId" text,"deviceId" uuid,"updatedAt" timestamptz);
    CREATE TABLE agent_runs (id uuid PRIMARY KEY,"deviceId" uuid,status text);`)
    await pool.query(await readFile(new URL('../drizzle/20261030193000_device_enrollment_management.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../drizzle/20261030231122_device_uninstall_command.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../drizzle/20261031002605_daemon_credential_revocation.sql', import.meta.url), 'utf8'))
  })
})
after(async () => { mock.restoreAll(); await scope.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })

test('registration grant is user-bound, expires, and has one concurrent winner', () => run(async () => {
  const { pool } = await import('./db')
  const token = await mintDeviceEnrollment('owner-a')
  const results = await Promise.all([consumeDeviceEnrollment(token), consumeDeviceEnrollment(token)])
  const credential = results.find(Boolean)!
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(await consumeDeviceEnrollment(token), null)
  const rows = await pool.query(`SELECT "userId" FROM device_tokens WHERE "tokenHash"=$1`, [hashDeviceToken(credential)])
  assert.equal(rows.rows[0].userId, 'owner-a')
  const expired = await mintDeviceEnrollment('owner-b')
  await pool.query(`UPDATE device_enrollments SET "expiresAt"=now()-interval '1 second' WHERE "tokenHash"=$1`, [hashDeviceToken(expired)])
  assert.equal(await consumeDeviceEnrollment(expired), null)
  assert.equal(await consumeDeviceEnrollment('invalid'), null)
}))

async function removableDevice(online: boolean) {
  const { pool } = await import('./db')
  const id = randomUUID(), tokenId = randomUUID(), credential = `fixture-${randomUUID()}`
  await pool.query(`INSERT INTO devices(id,"ownerId","lastSeenAt") VALUES($1,'owner-a',now()-$2::interval)`, [id, online ? '1 second' : '2 minutes'])
  await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,'owner-a',$2)`, [tokenId, hashDeviceToken(credential)])
  await pool.query(`INSERT INTO device_token_devices VALUES($1,$2,'owner-a')`, [tokenId, id])
  const request = (path: string, method = 'POST') => new Request(`http://localhost/mikka${path}`, { method, headers: { authorization: `Bearer ${credential}` } })
  return { id, tokenId, request }
}

test('online removal offers only uninstall, and its own receipt revokes credentials', () => run(async () => {
  const { pool } = await import('./db')
  const device = await removableDevice(true), other = await removableDevice(true)
  const prior = await enqueueDeviceCommand('owner-a', device.id, 'restart')
  const foreign = await enqueueDeviceCommand('owner-a', other.id, 'update')
  assert.deepEqual(await removeOwnedDevice('owner-a', device.id), { id: device.id, revokedTokens: 0, uninstall: 'queued' })
  const heartbeat = device.request(`/v1/devices/${device.id}/heartbeat`)
  assert.equal((await authenticateDevice(heartbeat))?.removingDeviceId, device.id)
  for (const path of ['/v1/devices/register', `/v1/devices/${device.id}/repos`, `/v1/devices/${other.id}/heartbeat`, `/v1/devices/${device.id}/commands`]) {
    assert.equal(await authenticateDevice(device.request(path)), null)
  }
  const { POST } = await import('../app/v1/devices/[deviceId]/heartbeat/route')
  const postHeartbeat = (completedDeviceCommands: string[]) => POST(new Request(heartbeat, {
    method: 'POST',
    body: JSON.stringify({ harnesses: [], runs: [], worktreeDiskBytes: 0, completedDeviceCommands }),
  }), { params: Promise.resolve({ deviceId: device.id }) })
  const response = await postHeartbeat([prior!, foreign!])
  assert.equal(response.status, 200)
  const pending = (await response.json()).deviceCommands as { id: string; kind: string }[]
  assert.equal(pending.length, 1); assert.equal(pending[0].kind, 'uninstall')
  assert.equal((await pool.query(`SELECT "completedAt" FROM device_management_commands WHERE id=$1`, [prior])).rows[0].completedAt, null)
  assert.equal((await pool.query(`SELECT "completedAt" FROM device_management_commands WHERE id=$1`, [foreign])).rows[0].completedAt, null)
  const acknowledged = await postHeartbeat([pending[0].id])
  assert.equal(acknowledged.status, 200)
  assert.deepEqual((await acknowledged.json()).deviceCommands, [])
  assert.ok((await pool.query(`SELECT "revokedAt" FROM device_tokens WHERE id=$1`, [device.tokenId])).rows[0].revokedAt)
  assert.equal(await authenticateDevice(heartbeat), null)
  assert.ok(await authenticateDevice(other.request(`/v1/devices/${other.id}/heartbeat`)))
}))

test('unacknowledged uninstall expires after ten minutes; offline removal revokes immediately', () => run(async () => {
  const { pool } = await import('./db')
  const online = await removableDevice(true), offline = await removableDevice(false)
  // Disabling dispatch does not disconnect the daemon or prevent uninstall.
  await pool.query(`UPDATE devices SET enabled=false WHERE id=$1`, [online.id])
  const started = Date.now()
  await removeOwnedDevice('owner-a', online.id)
  const expiry = (await pool.query(`SELECT "expiresAt" FROM device_tokens WHERE id=$1`, [online.tokenId])).rows[0].expiresAt.getTime()
  assert.ok(expiry >= started + 10 * 60_000 && expiry <= Date.now() + 10 * 60_000)
  await pool.query(`UPDATE device_tokens SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [online.tokenId])
  assert.equal(await authenticateDevice(online.request(`/v1/devices/${online.id}/heartbeat`)), null)
  assert.deepEqual(await removeOwnedDevice('owner-a', offline.id), { id: offline.id, revokedTokens: 1, uninstall: 'not_possible' })
  assert.equal(await authenticateDevice(offline.request(`/v1/devices/${offline.id}/heartbeat`)), null)
  assert.equal((await pool.query(`SELECT 1 FROM device_management_commands WHERE "deviceId"=$1`, [offline.id])).rowCount, 0)
}))

test('management queue is owner-scoped, serial and acknowledges only its device', () => run(async () => {
  const { pool } = await import('./db')
  const a = randomUUID(), b = randomUUID(), cloud = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",kind) VALUES ($1,'owner-a','local'),($2,'owner-b','local'),($3,'owner-a','cloud')`, [a, b, cloud])
  assert.equal(await enqueueDeviceCommand('owner-b', a, 'restart'), undefined)
  assert.equal(await enqueueDeviceCommand('owner-a', cloud, 'restart'), undefined)
  await pool.query(`UPDATE devices SET "removedAt"=now() WHERE id=$1`, [b])
  assert.equal(await enqueueDeviceCommand('owner-b', b, 'restart'), undefined)
  const first = await enqueueDeviceCommand('owner-a', a, 'redetect')
  const second = await enqueueDeviceCommand('owner-a', a, 'restart')
  const third = await enqueueDeviceCommand('owner-a', a, 'update')
  assert.deepEqual(await pendingDeviceCommands(a, []), [{ id: first, kind: 'redetect' }])
  await pendingDeviceCommands(b, [first!])
  assert.deepEqual(await pendingDeviceCommands(a, [first!]), [{ id: second, kind: 'restart' }])
  assert.deepEqual(await pendingDeviceCommands(a, [], [{ id: second!, error: 'not managed' }]), [{ id: third, kind: 'update' }])
  assert.deepEqual(await pendingDeviceCommands(a, [third!]), [])
  const receipt = await pool.query(`SELECT "completedAt" FROM device_management_commands WHERE id=$1`, [third])
  await pendingDeviceCommands(a, [third!])
  const replay = await pool.query(`SELECT "completedAt" FROM device_management_commands WHERE id=$1`, [third])
  assert.equal(receipt.rows[0].completedAt.getTime(), replay.rows[0].completedAt.getTime())
}))
