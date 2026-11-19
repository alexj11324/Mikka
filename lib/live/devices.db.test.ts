import assert from 'node:assert/strict'
import { wireKeys } from './wire-keys.test-support'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'
import type { LiveInvalidation } from './events'
import { liveChannelId, type LiveScope } from './scope'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('the device list key reaches only the owner home, after real device writers commit', { skip: !url, timeout: 180_000 }, async t => {
  const pending: (() => Promise<void>)[] = []
  const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  const next = await import('@/lib/server-runtime/server')
  mock.module('@/lib/server-runtime/server', { namedExports: { ...next, after: (work: () => Promise<void>) => { pending.push(work) } } })
  const channelScopes = new Map<string, LiveScope>(), unexpected: string[] = []
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-device-list-secret'
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const target = new URL(String(input))
    assert.equal(target.hostname, 'gateway.example.invalid', 'no provider or production request is allowed')
    // A device's own gateway presence and work notifications are not list keys.
    if (!target.pathname.startsWith('/v1/live/')) return new Response(JSON.stringify({ online: false }), { status: 200 })
    const scope = channelScopes.get(target.pathname)
    if (!scope) unexpected.push(target.pathname)
    const events: LiveInvalidation[] = wireKeys(JSON.parse(String(options?.body)), 'a key carries a kind and an id only')
    const devices = events.filter(event => event.kind === 'device_list')
    if (devices.length) sent.push({ scope: scope ?? { ownerId: 'unexpected', workspaceId: target.pathname }, events: devices })
    return new Response(null, { status: 204 })
  })
  const admin = new Pool({ connectionString: url, max: 1 })
  const name = `device_live_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, name, 'template0')
  const target = new URL(url!); target.pathname = `/${name}`
  const database = new Pool({ connectionString: target.toString(), max: 6 })
  observePoolCommits(database)
  const globalDb = globalThis as unknown as { workspacePool?: Pool }
  const previousWorkspace = globalDb.workspacePool
  globalDb.workspacePool = database
  const { createRequestDatabaseScope } = await import('../db/request-scope')
  const scope = createRequestDatabaseScope(target.toString())
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0).map(work => work())) }
  const deliveries = async () => { await drain(); return sent.splice(0) }
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await database.query(await readFile(new URL(file, dir), 'utf8'))
    for (const userId of ['owner', 'peer']) {
      await database.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$1||'@device.example.invalid',true,now(),now())`, [userId])
    }
    const home = randomUUID(), team = randomUUID(), peerHome = randomUUID()
    for (const ownerId of ['owner', 'peer']) for (const workspaceId of [home, team, peerHome]) {
      const value = { ownerId, workspaceId }; channelScopes.set(`/v1/live/${liveChannelId(value)}/push`, value)
    }
    for (const [id, owner, kind] of [[home, 'owner', 'personal'], [team, 'owner', 'team'], [peerHome, 'peer', 'personal']]) {
      await database.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES ($1,$2,'Fixture',$3)`, [id, owner, kind])
    }
    // Team membership does not grant the peer access to the owner's devices.
    for (const [workspace, userId] of [[home, 'owner'], [team, 'owner'], [team, 'peer'], [peerHome, 'peer']]) {
      await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`, [workspace, userId])
    }
    await assert.rejects(database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,'peer','peer','peer','member','active')`, [home]), { code: '23514' }, 'a Personal workspace cannot admit another owner')
    const device = randomUUID(), token = `orv_${randomBytes(32).toString('base64url')}`
    const codex = { harness: 'codex', installed: true, version: '1.0.0' }, claude = { harness: 'claude_code', installed: true, version: '2.1.0' }
    await database.query(`INSERT INTO devices(id,name,"ownerId",harnesses,"lastSeenAt","sessionOpenedAt") VALUES ($1,'mine','owner',$2,now(),now())`, [device, JSON.stringify([codex])])
    await database.query(`INSERT INTO device_tokens(id,"userId","tokenHash") VALUES ($1,'owner',$2)`, [randomUUID(), createHash('sha256').update(token).digest('hex')])
    const ownerHome = [{ scope: { ownerId: 'owner', workspaceId: home }, events: [{ kind: 'device_list', id: home }] }]

    await t.test('a session that opens or closes, or a harness change, pushes the device list; an unchanged report does not', async () => {
      const [{ POST }, { applyDeviceSessionReport }] = await Promise.all([import('../../app/v1/devices/[deviceId]/report/route'), import('../device-session')])
      const report = async (harnesses: unknown[]) => {
        const response = await scope.run(() => POST(new Request(`http://127.0.0.1/v1/devices/${device}/report`, {
          method: 'POST', headers: { 'x-mikka-device-session': '1', 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ harnesses }),
        }), { params: Promise.resolve({ deviceId: device }) }))
        assert.equal(response.status, 200)
      }
      const session = (state: 'connected' | 'disconnected', socketId: string) => scope.run(() => applyDeviceSessionReport(device, { state, at: new Date().toISOString(), socketId }))
      const deviceLists = async () => (await deliveries()).filter(delivery => delivery.events.some(event => event.kind === 'device_list'))
      await report([codex])
      assert.deepEqual(await deliveries(), [], 'an unchanged report is not a list change')
      assert.deepEqual((await session('disconnected', 'socket-unknown0')).applied, false)
      assert.deepEqual(await deliveries(), [], 'a report for another socket changes nothing')
      await session('connected', 'socket-livedev01')
      assert.deepEqual(await deviceLists(), ownerHome, 'a session that opens is one device-list push to the owner home')
      await session('disconnected', 'socket-livedev01')
      assert.deepEqual(await deviceLists(), ownerHome, 'a session that closes is one too')
      await report([codex, claude])
      assert.deepEqual(await deliveries(), ownerHome, 'a new harness shows in the list')
    })

    await t.test('only the owner can set or clear a local device description, with no repeated invalidation', async () => {
      const { setOwnedDeviceDescription } = await import('../device-removal')
      const save = (user: string, text: string, id = device) => scope.run(() => setOwnedDeviceDescription(user, id, text))
      const read = () => database.query('SELECT description, "updatedAt"::text AS updated FROM devices WHERE id=$1', [device]).then(result => result.rows[0])
      assert.equal((await read()).description, null)
      await assert.rejects(save('peer', 'private'), /deviceNotFound/)
      await assert.rejects(save('owner', 'a'.repeat(501)), /agentInvalidInput/)
      await assert.rejects(save('owner', 'null\0byte'), /agentInvalidInput/)
      const cloudDevice = randomUUID(), removedDevice = randomUUID()
      await database.query(`INSERT INTO devices(id,name,"ownerId",kind,"removedAt") VALUES
        ($1,'cloud','owner','cloud',NULL),($2,'removed','owner','local',now())`, [cloudDevice, removedDevice])
      await assert.rejects(save('owner', 'private', cloudDevice), /deviceNotFound/)
      await assert.rejects(save('owner', 'private', removedDevice), /deviceNotFound/)
      assert.deepEqual(await deliveries(), [])
      const description = 'a'.repeat(500)
      assert.deepEqual(await save('owner', ' ' + description + ' '), { id: device, description })
      assert.deepEqual(await deliveries(), ownerHome)
      const saved = await read()
      assert.equal(saved.description, description)
      await save('owner', description)
      assert.deepEqual(await read(), saved)
      assert.deepEqual(await deliveries(), [])
      assert.deepEqual(await save('owner', '   '), { id: device, description: null })
      assert.equal((await read()).description, null)
      assert.deepEqual(await deliveries(), ownerHome)
    })

    await t.test('rename and removal publish after COMMIT only; another owner and a rollback publish nothing', async () => {
      const { removeOwnedDevice, renameOwnedDevice } = await import('../device-removal')
      await assert.rejects(scope.run(() => renameOwnedDevice('peer', device, 'stolen')), /deviceNotFound/)
      assert.deepEqual(await deliveries(), [])
      await scope.run(() => renameOwnedDevice('owner', device, 'Work laptop'))
      assert.deepEqual(await deliveries(), ownerHome)
      await database.query(`CREATE FUNCTION reject_device_removal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."removedAt" IS NOT NULL THEN RAISE EXCEPTION 'device removal rejected'; END IF; RETURN NEW; END $$`)
      await database.query(`CREATE CONSTRAINT TRIGGER reject_device_removal AFTER UPDATE ON devices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_device_removal()`)
      try {
        await assert.rejects(scope.run(() => removeOwnedDevice('owner', device)), (error: unknown) => String((error as { cause?: unknown }).cause ?? error).includes('device removal rejected'))
        assert.deepEqual(await deliveries(), [], 'a failed COMMIT discards the registered key')
      } finally {
        await database.query('DROP TRIGGER reject_device_removal ON devices')
        await database.query('DROP FUNCTION reject_device_removal()')
      }
      await database.query(`UPDATE devices SET "lastSeenAt"=now()-interval '10 minutes',"sessionClosedAt"=clock_timestamp() WHERE id=$1`, [device])
      await scope.run(() => removeOwnedDevice('owner', device))
      await database.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='owner'`, [home])
      assert.deepEqual(await deliveries(), [], 'a home lost between COMMIT and delivery receives nothing')
      await database.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"='owner'`, [home])
      assert.deepEqual(unexpected, [])
    })
  } finally {
    await drain().catch(() => {})
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    globalDb.workspacePool = previousWorkspace
    await scope.close(); await database.end()
    await dropTestDatabase(admin, name); await admin.end()
    mock.restoreAll()
  }
})
