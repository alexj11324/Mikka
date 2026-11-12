import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { measured } from '../tests/helpers/read-metrics'
import { Pool } from 'pg'
import { createRequestDatabaseScope } from './db/request-scope'
import { mintDeviceEnrollment, consumeDeviceEnrollment } from './device-enrollment'
import { authenticateDevice, hashDeviceToken, linkDeviceToken } from './device-link'
import { enqueueDeviceCommand, pendingDeviceCommands } from './device-management'
import { removeOwnedDevice, setOwnedDeviceEnabled } from './device-removal'
import { checkOwnedEnrollment, enrollmentToken } from '../scripts/acceptance/self-hosted-daemon.mjs'

const url = process.env.E2E_DATABASE_URL
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_e2e')) throw new Error('An isolated loopback *_e2e database is required')
const schema = `device491_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: url })
const target = new URL(url)
target.searchParams.set('options', `-c search_path=${schema}`)
const scope = createRequestDatabaseScope(target.toString())
const run = <T>(fn: () => T) => scope.run(fn)
let browserOwner: string | null = null
let freshSessionRead = false
before(async () => {
  // Device heartbeat uses bearer authentication; unrelated human-session setup is not used here.
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async (options: { query?: { disableCookieCache?: boolean } }) => {
    freshSessionRead = options?.query?.disableCookieCache === true
    return browserOwner ? { user: { id: browserOwner } } : null
  } } } } })
  await admin.query(`CREATE SCHEMA ${schema}`)
  await run(async () => {
    const { pool } = await import('./db')
    await pool.query(`CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text NOT NULL,kind text DEFAULT 'local',"removedAt" timestamptz,enabled boolean DEFAULT true,"lastSeenAt" timestamptz,"updatedAt" timestamptz);
    CREATE TABLE device_tokens (id uuid PRIMARY KEY,"userId" text NOT NULL,"tokenHash" text NOT NULL,name text,"createdAt" timestamptz NOT NULL DEFAULT now(),"lastUsedAt" timestamptz,"revokedAt" timestamptz,"boundDeviceId" uuid,"boundWorkspaceId" uuid,"expiresAt" timestamptz);
    CREATE TABLE device_token_devices ("tokenId" uuid,"deviceId" uuid,"userId" text,PRIMARY KEY("tokenId","deviceId"));
    CREATE TABLE agents (id uuid PRIMARY KEY,"userId" text,"deviceId" uuid,"updatedAt" timestamptz);
    CREATE TABLE agent_runs (id uuid PRIMARY KEY,"deviceId" uuid,status text,"deviceTokenId" uuid,"userId" text,"leaseExpiresAt" timestamptz);`)
    await pool.query(await readFile(new URL('../drizzle/20261030193000_device_enrollment_management.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../drizzle/20261030231122_device_uninstall_command.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../drizzle/20261031002605_daemon_credential_revocation.sql', import.meta.url), 'utf8'))
  })
})
after(async () => { mock.restoreAll(); await scope.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })

test('desktop account context reads only the current browser owner\'s active local devices', () => run(async () => {
  const { pool } = await import('./db')
  const { GET } = await import('../app/api/devices/enrollment/route')
  const request = () => new Request('http://localhost/mikka/api/devices/enrollment')
  assert.equal((await GET(request())).status, 401)
  const own = randomUUID(), foreign = randomUUID(), cloud = randomUUID(), removed = randomUUID()
  await pool.query(`INSERT INTO devices(id,"ownerId",kind,"removedAt") VALUES ($1,'desktop-a','local',NULL),($2,'desktop-b','local',NULL),($3,'desktop-a','cloud',NULL),($4,'desktop-a','local',now())`, [own, foreign, cloud, removed])
  try {
    browserOwner = 'desktop-a'
    const first = await GET(request())
    assert.equal(first.headers.get('Cache-Control'), 'private, no-store')
    assert.deepEqual(await first.json(), { ownerId: 'desktop-a', deviceIds: [own] })
    assert.equal(freshSessionRead, true)
    browserOwner = 'desktop-b'
    assert.deepEqual(await (await GET(request())).json(), { ownerId: 'desktop-b', deviceIds: [foreign] })
  } finally { browserOwner = null }
}))

test('the Settings scheduling switch changes only a visible owned local device', () => run(async () => {
  const { pool } = await import('./db')
  const own = randomUUID(), foreign = randomUUID(), cloud = randomUUID(), removed = randomUUID()
  await pool.query(`INSERT INTO devices(id,"ownerId",kind,"removedAt") VALUES
    ($1,'switch-owner','local',NULL),($2,'switch-other','local',NULL),($3,'switch-owner','cloud',NULL),($4,'switch-owner','local',now())`,
  [own, foreign, cloud, removed])
  for (const deviceId of [foreign, cloud, removed, randomUUID()]) {
    await assert.rejects(setOwnedDeviceEnabled('switch-owner', deviceId, false), /deviceNotFound/)
  }
  assert.deepEqual(await setOwnedDeviceEnabled('switch-owner', own, false), { success: true })
  const disabled = await pool.query('SELECT id FROM devices WHERE id=ANY($1::uuid[]) AND NOT enabled', [[own, foreign, cloud, removed]])
  assert.deepEqual(disabled.rows, [{ id: own }])
}))

test('local setup owner view retains fresh session checks without reading unused devices', () => run(async () => {
  const { GET } = await import('../app/api/devices/enrollment/route')
  const request = (query = '?view=owner') => new Request('http://localhost/mikka/api/devices/enrollment' + query)
  const previousOwner = browserOwner
  try {
    browserOwner = null
    assert.equal((await GET(request())).status, 401)
    for (const owner of ['setup-owner-a', 'setup-owner-b', 'setup-owner-a']) {
      browserOwner = owner; freshSessionRead = false
      const read = await measured(async () => {
        const response = await GET(request())
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
        return response.json()
      })
      assert.deepEqual(read.value, { ownerId: owner })
      assert.equal(freshSessionRead, true, 'owner admission still requests the current database session')
      assert.equal(read.statements, 0, 'the mocked auth boundary adds no SQL and the owner view does not query devices')
      const full = await measured(async () => (await GET(request(''))).json())
      assert.deepEqual(full.value, { ownerId: owner, deviceIds: [] })
      assert.equal(full.statements, 1, 'the default verification view still reads current ownership from real Postgres')
    }
    browserOwner = null
    assert.equal((await GET(request())).status, 401, 'a previous identity cannot survive sign-out')
    for (const query of ['?view=', '?view=devices', '?view=owner&view=owner']) assert.equal((await GET(request(query))).status, 400)
  } finally { browserOwner = previousOwner }
}))

test('owner token pagination preserves microsecond ordering and rejects foreign or malformed anchors', () => run(async () => {
  const { pool } = await import('./db')
  const { GET } = await import('../app/api/device-tokens/route')
  const owner = `pages-${randomUUID()}`, foreign = `foreign-${randomUUID()}`
  const previousOwner = browserOwner
  const request = (query = '') => new Request('http://localhost/mikka/api/device-tokens' + query)
  try {
    await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash",name,"createdAt","revokedAt")
      SELECT gen_random_uuid(),$1,'hash-must-not-leak-' || $1 || n,'Fixture',
        '2026-11-08T00:00:00Z'::timestamptz + (n % 3)*interval '1 microsecond',now()
      FROM generate_series(1,263) n`, [owner])
    const foreignId = randomUUID()
    await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash",name) VALUES($1,$2,'foreign-hash','Foreign')`, [foreignId, foreign])
    browserOwner = null
    assert.equal((await GET(request())).status, 401)
    browserOwner = owner
    const found: string[] = [], pages: number[] = []
    let cursor: string | null = null
    do {
      const response = await GET(request(cursor ? '?cursor=' + cursor : ''))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
      const page = await response.json()
      assert.equal(JSON.stringify(page).includes('hash-must-not-leak'), false)
      assert.ok(page.tokens.every((row: { name: string }) => row.name === 'Fixture'))
      pages.push(page.tokens.length); found.push(...page.tokens.map((row: { id: string }) => row.id))
      cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual(pages, [100, 100, 63])
    const expected = await pool.query('SELECT id FROM device_tokens WHERE "userId"=$1 ORDER BY "createdAt" DESC,id', [owner])
    assert.deepEqual(found, expected.rows.map(row => row.id))
    assert.equal(new Set(found).size, 263)
    for (const query of ['?cursor=', '?cursor=not-a-uuid', '?cursor=' + foreignId, '?cursor=' + randomUUID(),
      '?cursor=' + found[0] + '&cursor=' + found[1]]) {
      assert.equal((await GET(request(query))).status, 400)
    }
  } finally {
    browserOwner = previousOwner
    await pool.query('DELETE FROM device_tokens WHERE "userId"=ANY($1::text[])', [[owner, foreign]])
  }
}))

test('owner token metadata projects only recorded owner-bound device IDs without credential material or writes', () => run(async () => {
  const { pool } = await import('./db')
  const { GET } = await import('../app/api/device-tokens/route')
  const owner = `links-${randomUUID()}`, foreign = `foreign-${randomUUID()}`
  const [tokenId, boundToken, emptyToken, foreignToken, local, removed, cloud, badMapping, otherDevice] = Array.from({ length: 9 }, () => randomUUID())
  const previousOwner = browserOwner
  const request = () => new Request('http://localhost/mikka/api/device-tokens')
  try {
    await pool.query(`INSERT INTO devices(id,"ownerId",kind,"removedAt") VALUES
      ($1,$6,'local',NULL),($2,$6,'local',now()),($3,$6,'cloud',NULL),($4,$6,'local',NULL),($5,$7,'local',NULL)`,
    [local, removed, cloud, badMapping, otherDevice, owner, foreign])
    await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash",name,"boundDeviceId") VALUES
      ($1,$5,'private-hash-fixture','SSH',NULL),($2,$5,'private-bound-hash','Cloud',$6),
      ($3,$5,'private-empty-hash','Empty',NULL),($4,$7,'private-foreign-hash','Foreign',NULL)`,
    [tokenId, boundToken, emptyToken, foreignToken, owner, cloud, foreign])
    await pool.query(`INSERT INTO device_token_devices("tokenId","deviceId","userId") VALUES
      ($1,$4,$8),($1,$5,$8),($1,$6,$9),($1,$7,$8),($2,$10,$8),($3,$4,$8)`,
    [tokenId, boundToken, foreignToken, local, removed, badMapping, otherDevice, owner, foreign, cloud])
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)) FROM device_tokens t) AS tokens,
      (SELECT md5(string_agg(to_jsonb(d)::text,'' ORDER BY id)) FROM devices d) AS devices,
      (SELECT md5(string_agg(to_jsonb(b)::text,'' ORDER BY "tokenId","deviceId")) FROM device_token_devices b) AS links`)).rows[0]
    const beforeRead = await snapshot()
    browserOwner = owner; freshSessionRead = false
    const response = await GET(request()), body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    assert.equal(freshSessionRead, true)
    assert.deepEqual(body.tokens.find((row: { id: string }) => row.id === tokenId).deviceIds, [local, removed].sort())
    assert.deepEqual(body.tokens.find((row: { id: string }) => row.id === boundToken).deviceIds, [cloud], 'bound and linked copies are deduplicated')
    assert.deepEqual(body.tokens.find((row: { id: string }) => row.id === emptyToken).deviceIds, [])
    assert.equal(body.tokens.some((row: { id: string }) => row.id === foreignToken), false)
    for (const value of ['private-hash-fixture', 'private-bound-hash', 'private-empty-hash', 'private-foreign-hash', otherDevice, badMapping])
      assert.equal(JSON.stringify(body).includes(value), false, 'foreign associations and credential hashes stay private')
    assert.deepEqual(await snapshot(), beforeRead, 'the normal owner metadata route is read-only')
    browserOwner = foreign
    assert.deepEqual((await (await GET(request())).json()).tokens.map((row: { id: string; deviceIds: string[] }) => ({ id: row.id, deviceIds: row.deviceIds })),
      [{ id: foreignToken, deviceIds: [] }], 'a corrupt foreign token link cannot expose the other owner device')
  } finally {
    browserOwner = previousOwner
    await pool.query('DELETE FROM device_token_devices WHERE "tokenId"=ANY($1::uuid[])', [[tokenId, boundToken, emptyToken, foreignToken]])
    await pool.query('DELETE FROM device_tokens WHERE id=ANY($1::uuid[])', [[tokenId, boundToken, emptyToken, foreignToken]])
    await pool.query('DELETE FROM devices WHERE id=ANY($1::uuid[])', [[local, removed, cloud, badMapping, otherDevice]])
  }
}))

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

test('daemon acceptance follows real local enrollment and owner routes without a cloud token binding', () => run(async () => {
  const { pool } = await import('./db')
  const { GET: readTokens } = await import('../app/api/device-tokens/route')
  const { GET: readEnrollment } = await import('../app/api/devices/enrollment/route')
  const owner = `acceptance-${randomUUID()}`, deviceId = randomUUID()
  const request = () => new Request('http://localhost/mikka/api/device-tokens')
  const previousOwner = browserOwner
  try {
    browserOwner = owner
    assert.deepEqual(await (await readTokens(request())).json(), { tokens: [], nextCursor: null })
    const credential = await consumeDeviceEnrollment(await mintDeviceEnrollment(owner))
    assert.ok(credential)
    const { tokens } = await (await readTokens(request())).json()
    const token = enrollmentToken(tokens)
    assert.equal(token.boundDeviceId, null)
    assert.deepEqual(token.deviceIds, [])
    assert.equal(token.revokedAt, null)
    const caller = await authenticateDevice(new Request('http://localhost/mikka/v1/devices/register', {
      headers: { authorization: `Bearer ${credential}` },
    }))
    assert.deepEqual(caller, { userId: owner, tokenId: token.id })
    await pool.query('INSERT INTO devices(id,"ownerId") VALUES($1,$2)', [deviceId, owner])
    assert.equal(await linkDeviceToken(caller!, deviceId), true)
    const account = await (await readEnrollment(new Request('http://localhost/mikka/api/devices/enrollment'))).json()
    checkOwnedEnrollment(account, owner, deviceId)
    const registeredToken = enrollmentToken((await (await readTokens(request())).json()).tokens)
    assert.equal(registeredToken.boundDeviceId, null,
      'registering a local device links device_token_devices instead of assigning a cloud scope')
    assert.deepEqual(registeredToken.deviceIds, [deviceId], 'the owner readback exposes the real enrollment association')
    browserOwner = `foreign-${owner}`
    assert.deepEqual(await (await readTokens(request())).json(), { tokens: [], nextCursor: null })
    assert.throws(() => checkOwnedEnrollment(account, browserOwner!, deviceId), /OWNER_DEVICE/)
    browserOwner = owner
    await consumeDeviceEnrollment(await mintDeviceEnrollment(owner))
    const ambiguous = await (await readTokens(request())).json()
    assert.throws(() => enrollmentToken(ambiguous.tokens), /TOKEN_IDENTITY/)
  } finally { browserOwner = previousOwner }
}))

async function removableDevice(online: boolean) {
  const { pool } = await import('./db')
  const id = randomUUID(), tokenId = randomUUID(), credential = `fixture-${randomUUID()}`
  await pool.query(`INSERT INTO devices(id,"ownerId","lastSeenAt") VALUES($1,'owner-a',now()-$2::interval)`, [id, online ? '1 second' : '2 minutes'])
  await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,'owner-a',$2)`, [tokenId, hashDeviceToken(credential)])
  await pool.query(`INSERT INTO device_token_devices VALUES($1,$2,'owner-a')`, [tokenId, id])
  const request = (path: string, method = 'POST') => new Request(`http://localhost/mikka${path}`, { method, headers: { 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${credential}` } })
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

test('a fresh login cannot admit an old daemon, and updating cannot revive a revoked credential', () => run(async () => {
  const { pool } = await import('./db')
  const { withDeviceRoute } = await import('./device-route')
  const { MIN_DAEMON_VERSION } = await import('@mikka/protocol/device')
  const grant = await mintDeviceEnrollment('version-owner')
  const credential = await consumeDeviceEnrollment(grant)
  assert.ok(credential)
  let invoked = 0
  const handler = withDeviceRoute(async () => { await pool.query('SELECT 1'); invoked++; return Response.json({ ok: true }) })
  const request = (version: string | null, path = '/v1/devices/fixture/repos') => new Request(`http://localhost/mikka${path}`, {
    headers: { authorization: `Bearer ${credential}`, ...(version === null ? {} : { 'x-mikka-client-version': version }) },
  })
  for (const version of ['0.0.329', '0.0.374', null]) {
    const response = await handler(request(version))
    assert.equal(response.status, 426)
    assert.equal((await response.json()).minVersion, MIN_DAEMON_VERSION)
  }
  assert.equal(invoked, 0, 'fresh authentication does not grant business access to old code')
  assert.equal((await handler(request(MIN_DAEMON_VERSION))).status, 200)
  assert.equal(invoked, 1)
  // Already claimed work may finish using its original credential. A new
  // credential cannot inherit this grace from merely owning the same device.
  const tokenId = (await pool.query('SELECT id FROM device_tokens WHERE "tokenHash"=$1', [hashDeviceToken(credential)])).rows[0].id
  const claimedRun = randomUUID()
  await pool.query(`INSERT INTO agent_runs(id,status,"deviceTokenId","userId","leaseExpiresAt") VALUES($1,'running',$2,'version-owner',now()+interval '1 minute')`, [claimedRun, tokenId])
  assert.equal((await handler(request('0.0.329'))).status, 426, 'a live run does not admit unrelated repos polling')
  assert.equal((await handler(request('0.0.329', `/v1/runs/${randomUUID()}/events`))).status, 426, 'another run cannot borrow the lease')
  assert.equal((await handler(request('0.0.329', `/v1/runs/${claimedRun}/events`))).status, 200)
  const fresh = await consumeDeviceEnrollment(await mintDeviceEnrollment('version-owner'))
  const freshRequest = new Request(request('0.0.329', `/v1/runs/${claimedRun}/events`), { headers: { authorization: `Bearer ${fresh}`, 'x-mikka-client-version': '0.0.329' } })
  assert.equal((await handler(freshRequest)).status, 426)
  await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId])
  assert.equal((await handler(request(MIN_DAEMON_VERSION))).status, 401, 'new binary plus revoked old session is still unauthorized')
  assert.equal((await handler(request('0.0.329', '/v1/devices/fixture/commands'))).status, 401, 'control traffic does not bypass revocation')
}))

test('registration metadata cannot disguise an old daemon behind a current header', () => run(async () => {
  const { POST } = await import('../app/v1/devices/register/route')
  const { MIN_DAEMON_VERSION } = await import('@mikka/protocol/device')
  const credential = await consumeDeviceEnrollment(await mintDeviceEnrollment('body-version-owner'))
  const response = await POST(new Request('http://localhost/mikka/v1/devices/register', {
    method: 'POST', headers: { authorization: `Bearer ${credential}`, 'x-mikka-client-version': MIN_DAEMON_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'version fixture', platform: 'linux', arch: 'x64', daemonVersion: '0.0.329', protocolVersion: 1, harnesses: [] }),
  }))
  assert.equal(response.status, 426)
}))
