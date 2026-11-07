import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'
import { CloudServiceError } from './cloud-services/errors'
import { sealSecret } from './secrets/crypto'

const target = process.env.E2E_DATABASE_URL
const valid = isE2eTarget(target) && target === process.env.MIKKA_DATABASE_URL && target === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Push receipt tests require matching isolated loopback _e2e URLs')
let database: Pool
let cloud: (userId: string, scope: string, path: string, init: RequestInit) => Promise<Response>
let startFails = false, starts = 0
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('./db/index.ts', { pool: { query: (sql: string, values?: unknown[]) => database.query(sql, values) } })
stub('./edition.ts', { isCloudEdition: () => false })
stub('./cloud-services/runtime.ts', { cloudClient: { pushContent: async () => 'reminder' }, cloudRequest: (user: string, scope: string, path: string, init: RequestInit) => cloud(user, scope, path, init) })
mock.module('workflow/api', { namedExports: { start: async () => { starts++; if (startFails) throw new Error('fixture Workflow outage') } } })
stub('../workflows/phone-push-receipts/workflow.ts', { phonePushReceipts: async () => {} })

test('PG: receipt recovery survives a lost Workflow wake without sending accepted pushes twice', { skip: !valid }, async t => {
  const schema = `push_receipts_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: target, max: 1 })
  await admin.query(`CREATE SCHEMA ${schema}`)
  database = new Pool({ connectionString: target, options: `-c search_path=${schema}`, max: 5 })
  const oldKey = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('base64')
  t.after(async () => { await database.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); if (oldKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = oldKey })
  await database.query('CREATE TABLE "user"(id text PRIMARY KEY)')
  for (const file of ['20261107171001_cloud_service_client.sql', '20261107171003_cloud_push.sql', '20261107171004_phone_push_receipt_recovery.sql']) await database.query(await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'))
  await database.query('CREATE TABLE mobile_push_tokens (LIKE public.mobile_push_tokens INCLUDING ALL)')
  await database.query('INSERT INTO "user" VALUES ($1),($2)', ['owner', 'other'])
  const { deliverPhonePush, checkPhonePushReceipts, recoverPhonePushReceipts } = await import('./mobile-push-delivery')
  const token = 'ExpoPushToken[receipt_fixture]', proof = `1900000000.${'a'.repeat(64)}`
  const notification = { to: [token], title: 'Private title', body: 'Private body', data: { serverUrl: 'https://self.example/mikka', userId: 'owner', botId: null } }
  const addDevice = (owner = 'owner') => database.query('INSERT INTO mobile_push_tokens(id,"userId",token,platform) VALUES($1,$2,$3,$4)', [randomUUID(), owner, token, 'ios'])
  const seed = async (ticket = 'accepted') => {
    const id = randomUUID()
    await database.query("INSERT INTO mobile_push_receipts(id,user_id,provider,secret,next_check_at) VALUES($1,'owner','cloud',$2,now()-interval '1 second')", [id, sealSecret(JSON.stringify([{ id: ticket, token, proof }]), `mobile_push_receipts\0${id}`)])
    return id
  }
  const clear = async () => { await database.query('DELETE FROM mobile_push_receipts'); await database.query('DELETE FROM mobile_push_tokens'); starts = 0; startFails = false }

  await t.test('a failed start leaves a due receipt; reconciliation checks it and removes an invalid owned token', async () => {
    await addDevice(); startFails = true
    let sends = 0, checks = 0
    cloud = async (owner, scope, path, init) => {
      assert.equal(owner, 'owner'); assert.equal(scope, 'push')
      if (path === '/v1/push') { sends++; assert.equal(JSON.stringify(init.body).includes('Private'), false); return Response.json({ accepted: 1, invalidTokens: [], tickets: [{ id: 'accepted', token, proof }], failures: [] }) }
      assert.equal(path, '/v1/push/receipts'); checks++
      assert.deepEqual(JSON.parse(String(init.body)), { tickets: [{ id: 'accepted', proof }] })
      return Response.json({ invalidIds: ['accepted'], pendingIds: [], failures: [] })
    }
    await deliverPhonePush('owner', notification, 'en')
    assert.equal(starts, 1); assert.equal(sends, 1)
    const row = (await database.query('SELECT * FROM mobile_push_receipts')).rows[0]
    assert.equal(row.check_count, 0); assert.equal(row.lease_id, null)
    assert.equal(JSON.stringify(row.secret).includes(token), false)
    assert.deepEqual(await recoverPhonePushReceipts(), { scanned: 0, pending: 0, failed: 0 })
    await database.query("UPDATE mobile_push_receipts SET next_check_at=now()-interval '1 second'")
    assert.deepEqual(await recoverPhonePushReceipts(), { scanned: 1, pending: 0, failed: 0 })
    assert.equal(checks, 1); assert.equal(sends, 1); assert.equal(starts, 1)
    assert.equal((await database.query('SELECT count(*)::int AS count FROM mobile_push_receipts')).rows[0].count, 0)
    assert.equal((await database.query('SELECT count(*)::int AS count FROM mobile_push_tokens')).rows[0].count, 0)
    await clear()
  })

  await t.test('Workflow and reconciliation cannot claim the same receipt, and a persisted follow-up is checked only once', async () => {
    const id = await seed('pending')
    let entered!: () => void, release!: () => void, checks = 0
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    cloud = async (_user, _scope, path) => { assert.equal(path, '/v1/push/receipts'); checks++; entered(); await gate; return Response.json({ invalidIds: [], pendingIds: ['pending'], failures: [] }) }
    const first = checkPhonePushReceipts(id, false)
    await started
    assert.equal(await checkPhonePushReceipts(id, true), false)
    assert.deepEqual(await recoverPhonePushReceipts(), { scanned: 0, pending: 0, failed: 0 })
    release(); assert.equal(await first, true); assert.equal(checks, 1)
    const row = (await database.query('SELECT * FROM mobile_push_receipts WHERE id=$1', [id])).rows[0]
    assert.equal(row.check_count, 1); assert.equal(row.lease_id, null)
    assert.ok(row.next_check_at.getTime() > Date.now() + 44 * 60_000)
    await database.query("UPDATE mobile_push_receipts SET next_check_at=now()-interval '1 second' WHERE id=$1", [id])
    assert.deepEqual(await recoverPhonePushReceipts(), { scanned: 1, pending: 0, failed: 0 })
    assert.equal(checks, 2)
    assert.equal((await database.query('SELECT count(*)::int AS count FROM mobile_push_receipts')).rows[0].count, 0)
    await clear()
  })

  await t.test('a changed personal/team identity discards an old proof without fallback or token deletion', async () => {
    await addDevice()
    let checks = 0
    for (const code of ['cloud_invalid_request', 'cloud_access_denied']) {
      const id = await seed()
      cloud = async (_user, _scope, path) => { assert.equal(path, '/v1/push/receipts'); checks++; return Response.json({ code }, { status: code === 'cloud_invalid_request' ? 400 : 403 }) }
      assert.equal(await checkPhonePushReceipts(id, false), false)
      assert.deepEqual(await recoverPhonePushReceipts(), { scanned: 0, pending: 0, failed: 0 })
    }
    assert.equal(checks, 2)
    assert.equal((await database.query('SELECT "userId" FROM mobile_push_tokens WHERE token=$1', [token])).rows[0].userId, 'owner')
    await clear()
  })

  await t.test('a temporary lookup failure releases its lease with a persisted retry and never issues a send', async () => {
    const id = await seed(), original = new CloudServiceError('cloud_unavailable', 'network', new Error('fixture network failure'))
    cloud = async (_user, _scope, path) => { assert.equal(path, '/v1/push/receipts'); throw original }
    await assert.rejects(checkPhonePushReceipts(id, false), error => error === original)
    const row = (await database.query('SELECT * FROM mobile_push_receipts WHERE id=$1', [id])).rows[0]
    assert.equal(row.lease_id, null); assert.equal(row.lease_until, null); assert.equal(row.check_count, 0)
    assert.ok(row.next_check_at.getTime() > Date.now() + 110_000)
    await database.query("UPDATE mobile_push_receipts SET next_check_at=now()-interval '1 second',lease_until=now()-interval '1 second',lease_id=$2 WHERE id=$1", [id, randomUUID()])
    cloud = async (_user, _scope, path) => { assert.equal(path, '/v1/push/receipts'); return Response.json({ invalidIds: [], pendingIds: [], failures: [] }) }
    assert.deepEqual(await recoverPhonePushReceipts(), { scanned: 1, pending: 0, failed: 0 })
    await clear()
  })

  await t.test('old receipts cannot remove an Expo token reassigned to another signed-in account', async () => {
    await addDevice('other'); await seed()
    cloud = async (_user, _scope, path) => { assert.equal(path, '/v1/push/receipts'); return Response.json({ invalidIds: ['accepted'], pendingIds: [], failures: [] }) }
    await recoverPhonePushReceipts()
    assert.equal((await database.query('SELECT "userId" FROM mobile_push_tokens WHERE token=$1', [token])).rows[0].userId, 'other')
    await clear()
  })
})
