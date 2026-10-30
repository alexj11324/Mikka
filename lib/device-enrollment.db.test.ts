import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createRequestDatabaseScope } from './db/request-scope'
import { mintDeviceEnrollment, consumeDeviceEnrollment } from './device-enrollment'
import { hashDeviceToken } from './device-link'
import { enqueueDeviceCommand, pendingDeviceCommands } from './device-management'

const url = process.env.E2E_DATABASE_URL
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_e2e')) throw new Error('An isolated loopback *_e2e database is required')
const schema = `device491_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: url })
const target = new URL(url)
target.searchParams.set('options', `-c search_path=${schema}`)
const scope = createRequestDatabaseScope(target.toString())
const run = <T>(fn: () => T) => scope.run(fn)
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`)
  await run(async () => {
    const { pool } = await import('./db')
    await pool.query(`CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text NOT NULL,kind text DEFAULT 'local',"removedAt" timestamptz); CREATE TABLE device_tokens (id uuid PRIMARY KEY,"userId" text NOT NULL,"tokenHash" text NOT NULL,name text)`)
    await pool.query(await readFile(new URL('../drizzle/20261030193000_device_enrollment_management.sql', import.meta.url), 'utf8'))
  })
})
after(async () => { await scope.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })

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
