import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from '../tests/helpers/task-workspace'
import { measured } from '../tests/helpers/read-metrics'

// Database regressions execute only in CI against ephemeral Postgres 17.
// Local pure runs skip them; REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable CI database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching Actions loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

const SESSION = { 'x-mikka-device-session': '1' }
let nextMocked = false
async function mockNextServer() {
  if (nextMocked) return
  const next = await import('@/lib/server-runtime/server')
  mock.module('@/lib/server-runtime/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })
  nextMocked = true
}

/** One disposable owner with a local device, its credential and an Agent in a workspace. */
async function deviceFixture(pool: import('pg').Pool, label: string) {
  const owner = `test-${label}-${randomUUID()}`, device = randomUUID(), agent = randomUUID(), tokenId = randomUUID()
  const token = `orv_${randomBytes(32).toString('base64url')}`
  await pool.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, 'Session fixture', $1 || '@example.invalid', false, now(), now())`, [owner])
  const workspaceId = await seedFixtureWorkspace(pool, owner)
  await pool.query(`insert into devices (id, name, "ownerId", harnesses) values ($1, 'mine', $2, '[]')`, [device, owner])
  await pool.query(`insert into device_tokens (id, "userId", "tokenHash") values ($1, $2, $3)`, [tokenId, owner, createHash('sha256').update(token).digest('hex')])
  await pool.query(`insert into agents (id, "userId", name, harness, "deviceId") values ($1, $2, 'Session agent', 'codex', $3)`, [agent, owner, device])
  const run = async (status: string, lease: string | null = "now() + interval '5 minutes'", extra = '') => {
    const id = randomUUID()
    await pool.query(`insert into agent_runs (id, "agentId", "userId", "deviceId", "workspaceId", status, "leaseExpiresAt", "deviceTokenId"${extra ? ',"stopRequestedAt"' : ''})
      values ($1, $2, $3, $4, $5, $6, ${lease ?? 'NULL'}, $7${extra ? `,${extra}` : ''})`, [id, agent, owner, device, workspaceId, status, tokenId])
    return id
  }
  const cleanup = async () => {
    await pool.query('delete from agent_runs where "userId"=$1', [owner])
    await pool.query('delete from agents where "userId"=$1', [owner])
    await pool.query('delete from device_token_devices where "deviceId"=$1', [device]).catch(() => undefined)
    await pool.query('delete from device_tokens where "userId"=$1', [owner])
    await pool.query('delete from devices where "ownerId"=$1', [owner])
    await pool.query('delete from "user" where id=$1', [owner])
  }
  return { owner, device, agent, token, tokenId, workspaceId, run, cleanup }
}

dbTest('device session reports: the newest socket owns the session, reports are idempotent, and leases follow it', async t => {
  await mockNextServer()
  const [{ createRequestDatabaseScope, pool }, { applyDeviceSessionReport, deviceSessionHeld, closeLostDeviceSessions }, { SESSION_LEASE_MS }] = await Promise.all([
    import('./db'), import('./device-session'), import('@mikka/protocol/device')])
  const scope = createRequestDatabaseScope(databaseUrl!)
  let cleanup: (() => Promise<void>) | undefined
  t.after(async () => { try { if (cleanup) await scope.run(cleanup) } finally { await scope.close() } })
  await scope.run(async () => {
    const f = await deviceFixture(pool, 'session')
    cleanup = f.cleanup
    const report = (state: 'connected' | 'disconnected', at: Date, socketId: string) => applyDeviceSessionReport(f.device, { state, at: at.toISOString(), socketId })
    const session = async () => (await pool.query(`select "sessionOpenedAt" as opened, "sessionClosedAt" as closed, "sessionSocketId" as socket, "lastSeenAt" from devices where id=$1`, [f.device])).rows[0]
    const lease = async (id: string) => (await pool.query(`select "leaseExpiresAt" as at from agent_runs where id=$1`, [id])).rows[0].at as Date | null
    const t0 = new Date(Date.now() - 60_000), t1 = new Date(t0.getTime() + 10_000), t2 = new Date(t0.getTime() + 20_000)

    const live = await f.run('running'), queued = await f.run('queued'), stopping = await f.run('running', "now() + interval '5 minutes'", 'now()'), lapsed = await f.run('running', "now() - interval '1 second'")
    const before = { queued: await lease(queued), stopping: await lease(stopping), lapsed: await lease(lapsed) }

    await t.test('connected opens the session and extends live leases to the session lease', async () => {
      assert.deepEqual(await report('connected', t0, 'socket-aaaaaaaa'), { applied: true })
      const row = await session()
      assert.deepEqual([row.opened.getTime(), row.closed, row.socket], [t0.getTime(), null, 'socket-aaaaaaaa'])
      assert.equal(row.lastSeenAt.getTime(), t0.getTime(), 'last seen is the session time, for people only')
      assert.ok((await lease(live))!.getTime() > Date.now() + SESSION_LEASE_MS - 120_000)
      assert.deepEqual({ queued: await lease(queued), stopping: await lease(stopping), lapsed: await lease(lapsed) }, before, 'queued, stopping and ended leases are not extended')
      assert.deepEqual(await report('connected', t0, 'socket-aaaaaaaa'), { applied: true }, 'a retried report is idempotent')
      assert.equal((await session()).socket, 'socket-aaaaaaaa')
    })

    await t.test('a report for an older socket never overrides a newer one', async () => {
      assert.deepEqual(await report('connected', t1, 'socket-bbbbbbbb'), { applied: true }, 'a newer socket replaces it')
      assert.deepEqual(await report('connected', t0, 'socket-aaaaaaaa'), { applied: false }, 'a late connect of the old socket is ignored')
      assert.deepEqual(await report('disconnected', t2, 'socket-aaaaaaaa'), { applied: false }, 'a late close of the replaced socket is ignored')
      const row = await session()
      assert.deepEqual([row.opened.getTime(), row.closed, row.socket], [t1.getTime(), null, 'socket-bbbbbbbb'])
      assert.equal(await scope.run(async () => { const c = await pool.connect(); try { return await deviceSessionHeld(c, f.device) } finally { c.release() } }), true)
    })

    await t.test('disconnected closes the current socket and ends the leases of its runs at once', async () => {
      assert.deepEqual(await report('disconnected', t2, 'socket-bbbbbbbb'), { applied: true })
      const row = await session()
      assert.equal(row.closed.getTime(), t2.getTime())
      assert.ok((await lease(live))!.getTime() <= Date.now(), 'the live run lease ended')
      assert.ok((await lease(stopping))!.getTime() <= Date.now(), 'a stopping run lease ended too')
      assert.equal((await lease(queued))?.getTime(), before.queued?.getTime(), 'a queued run has no lease to end')
      assert.deepEqual(await report('disconnected', t2, 'socket-bbbbbbbb'), { applied: false }, 'idempotent')
      assert.deepEqual(await report('connected', t1, 'socket-bbbbbbbb'), { applied: false }, 'a retried connect cannot reopen a closed socket')
      const c = await pool.connect()
      try { assert.equal(await deviceSessionHeld(c, f.device), false, 'a claim sees no session') } finally { c.release() }
      // The live run is not extended by a later session: its lease already ended.
      assert.deepEqual(await report('connected', new Date(), 'socket-cccccccc'), { applied: true })
      assert.ok((await lease(live))!.getTime() <= Date.now(), 'an ended lease stays ended; run recovery owns it')
    })

    await t.test('the run-recovery backstop closes a session the gateway no longer has', async () => {
      const held = await f.run('running')
      const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
      const { createServer } = await import('node:http')
      const { once } = await import('node:events')
      let online = true
      const asked: string[] = []
      const server = createServer((request, response) => { asked.push(request.url ?? ''); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ online })) })
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const address = server.address() as import('node:net').AddressInfo
      process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${address.port}`
      process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-session-backstop-secret'
      try {
        const first = await closeLostDeviceSessions()
        assert.ok(asked.includes(`/v1/devices/${f.device}/status`), 'a device with a leased run and an open session is asked about')
        assert.equal((await session()).closed, null, 'online at the gateway: the session stays open')
        assert.ok(first.checked >= 1)
        online = false
        await closeLostDeviceSessions()
        assert.ok((await session()).closed, 'offline at the gateway: a synthetic disconnected closes it')
        assert.ok((await lease(held))!.getTime() <= Date.now(), 'and ends its leases')
        asked.length = 0
        await closeLostDeviceSessions()
        assert.ok(!asked.includes(`/v1/devices/${f.device}/status`), 'a closed session is not asked about again')
      } finally {
        if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
        if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })

    await t.test('the backstop asks the gateway about devices concurrently, so a slow gateway cannot outlast the cron', async () => {
      const others = await Promise.all([1, 2, 3].map(async n => { const g = await deviceFixture(pool, `session-concurrent-${n}`); await g.run('running'); return g }))
      const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
      const { createServer } = await import('node:http')
      const { once } = await import('node:events')
      let inFlight = 0, peak = 0
      const server = createServer((_request, response) => {
        peak = Math.max(peak, ++inFlight)
        setTimeout(() => { inFlight--; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ online: true })) }, 200)
      })
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
      process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-session-backstop-secret'
      try {
        for (const [n, g] of others.entries()) await applyDeviceSessionReport(g.device, { state: 'connected', at: new Date().toISOString(), socketId: `socket-concur0${n}` })
        const { checked } = await closeLostDeviceSessions()
        assert.ok(checked >= others.length)
        assert.ok(peak > 1, `status calls overlap (peak in flight: ${peak})`)
      } finally {
        if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
        if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
        for (const g of others) await g.cleanup()
      }
    })
  })
})

dbTest('the gateway reports sessions through the internal route with the push secret', async t => {
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'http://127.0.0.1:9'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-session-route-secret'
  t.after(() => {
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
  })
  const [{ createRequestDatabaseScope, pool }, { POST }] = await Promise.all([import('./db'), import('../app/v1/internal/device-sessions/[deviceId]/route')])
  const scope = createRequestDatabaseScope(databaseUrl!)
  let cleanup: (() => Promise<void>) | undefined
  t.after(async () => { try { if (cleanup) await scope.run(cleanup) } finally { await scope.close() } })
  await scope.run(async () => {
    const f = await deviceFixture(pool, 'session-route')
    cleanup = f.cleanup
    const post = (deviceId: string, body: unknown, secret = 'isolated-session-route-secret') => POST(new Request(`http://127.0.0.1/mikka/v1/internal/device-sessions/${deviceId}`, {
      method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
    }), { params: Promise.resolve({ deviceId }) })
    const connected = { state: 'connected', at: new Date().toISOString(), socketId: 'socket-route0001' }
    assert.equal((await post(f.device, connected, 'wrong-secret')).status, 401)
    assert.equal((await post(f.device, connected, '')).status, 401)
    for (const bad of ['{', { ...connected, state: 'open' }, { ...connected, socketId: 'x' }, { ...connected, extra: true }]) assert.equal((await post(f.device, bad)).status, 400)
    assert.equal((await pool.query('select "sessionOpenedAt" from devices where id=$1', [f.device])).rows[0].sessionOpenedAt, null, 'nothing applied before a valid report')
    assert.equal((await post(f.device, connected)).status, 204)
    assert.equal((await pool.query('select "sessionSocketId" from devices where id=$1', [f.device])).rows[0].sessionSocketId, 'socket-route0001')
    assert.equal((await post(randomUUID(), connected)).status, 204, 'an unknown device is acknowledged so the gateway stops retrying')
    assert.equal((await post('not-a-device', connected)).status, 204)
    await pool.query('update devices set "removedAt"=now() where id=$1', [f.device])
    assert.equal((await post(f.device, { ...connected, at: new Date(Date.now() + 1_000).toISOString(), socketId: 'socket-route0002' })).status, 204, 'a removed device is acknowledged')
    assert.equal((await pool.query('select "sessionSocketId" from devices where id=$1', [f.device])).rows[0].sessionSocketId, 'socket-route0001', 'and gains no session')
  })
})

dbTest('the report renews nothing, records what changed, hands over device commands, and serves a removed device only its uninstall', async t => {
  await mockNextServer()
  const [{ createRequestDatabaseScope, pool }, { POST }, { GET: commands }, { GET: gateway }] = await Promise.all([import('./db'),
    import('../app/v1/devices/[deviceId]/report/route'), import('../app/v1/devices/[deviceId]/commands/route'), import('../app/v1/devices/[deviceId]/gateway/route')])
  const scope = createRequestDatabaseScope(databaseUrl!)
  let cleanup: (() => Promise<void>) | undefined
  t.after(async () => { try { if (cleanup) await scope.run(cleanup) } finally { await scope.close() } })
  await scope.run(async () => {
    const f = await deviceFixture(pool, 'report')
    cleanup = f.cleanup
    const params = { params: Promise.resolve({ deviceId: f.device }) }
    const headers = (session = true) => ({ ...(session ? SESSION : {}), 'x-mikka-client-version': '999.0.0', authorization: `Bearer ${f.token}`, 'content-type': 'application/json' })
    const send = (body: Record<string, unknown>, session = true) => POST(new Request(`http://127.0.0.1/mikka/v1/devices/${f.device}/report`, { method: 'POST', headers: headers(session), body: JSON.stringify(body) }), params)
    const codex = { harness: 'codex', installed: true, version: '1.0.0' }
    const claude = { harness: 'claude_code', installed: true, version: '2.1.0' }

    await t.test('every device route refuses a daemon without a device session: 426, no grace', async () => {
      const refused = [
        await send({}, false),
        await commands(new Request(`http://127.0.0.1/mikka/v1/devices/${f.device}/commands`, { headers: headers(false) }), params),
        await gateway(new Request(`http://127.0.0.1/mikka/v1/devices/${f.device}/gateway`, { headers: headers(false) }), params),
      ]
      for (const response of refused) {
        assert.equal(response.status, 426)
        assert.equal((await response.json()).code, 'daemonUpgradeRequired')
      }
      const old = await POST(new Request(`http://127.0.0.1/mikka/v1/devices/${f.device}/report`, { method: 'POST', headers: { ...headers(), 'x-mikka-client-version': '0.0.300' }, body: '{}' }), params)
      assert.equal(old.status, 426, 'the minimum daemon version still applies')
    })

    await t.test('the gateway ticket requires a configured gateway', async () => {
      const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET, auth: process.env.BETTER_AUTH_URL }
      delete process.env.DEVICE_GATEWAY_URL; delete process.env.BETTER_AUTH_URL
      try {
        const none = await gateway(new Request(`http://127.0.0.1/mikka/v1/devices/${f.device}/gateway`, { headers: headers() }), params)
        assert.equal(none.status, 503)
        assert.deepEqual(await none.json(), { error: 'device_gateway_required', code: 'deviceGatewayRequired' })
        process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.test'
        process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-ticket-secret'
        const ticket = await (await gateway(new Request(`http://127.0.0.1/mikka/v1/devices/${f.device}/gateway`, { headers: headers() }), params)).json()
        assert.equal(ticket.url, `wss://gateway.example.test/v1/devices/${f.device}/socket`)
        assert.match(ticket.protocol, /^mikka-ticket-[0-9]+-[a-f0-9]{64}$/)
        assert.equal(ticket.cloudCredentialExpiresAt, undefined, 'only a scoped cloud token learns its expiry')
      } finally {
        for (const [key, value] of [['DEVICE_GATEWAY_URL', previous.url], ['DEVICE_GATEWAY_PUSH_SECRET', previous.secret], ['BETTER_AUTH_URL', previous.auth]] as const)
          if (value === undefined) delete process.env[key]; else process.env[key] = value
      }
    })

    await t.test('a report records harnesses, device type and update result, and renews no lease and no presence', async () => {
      const held = await f.run('running', "now() + interval '30 seconds'")
      const leaseBefore = (await pool.query('select "leaseExpiresAt" from agent_runs where id=$1', [held])).rows[0].leaseExpiresAt
      await pool.query(`update devices set "updateFailure"=$2 where id=$1`, [f.device, JSON.stringify({ code: 'install_failed' })])
      const empty = await send({})
      assert.equal(empty.status, 200)
      const body = await empty.json()
      assert.deepEqual(body.deviceCommands, [])
      assert.equal(body.daemonVersions.min.length > 0, true)
      assert.equal(body.leases, undefined)
      let device = (await pool.query('select * from devices where id=$1', [f.device])).rows[0]
      assert.deepEqual(device.updateFailure, { code: 'install_failed' }, 'a report without an update result keeps the last one')
      assert.equal(device.sessionOpenedAt, null, 'a report is not presence')
      assert.equal(device.lastSeenAt, null, 'and is not a heartbeat')
      await send({ harnesses: [codex, claude], deviceType: 'server', updateFailure: null, computerUse: { installed: true, version: '1.2.3' } })
      device = (await pool.query('select * from devices where id=$1', [f.device])).rows[0]
      assert.deepEqual(device.harnesses.map((info: { harness: string }) => info.harness), ['codex', 'claude_code'])
      assert.equal(device.deviceType, 'server')
      assert.equal(device.updateFailure, null)
      assert.deepEqual(device.computerUse, { installed: true, version: '1.2.3' })
      const identities = (await pool.query(`select harness from agents where "userId"=$1 and "deviceId"=$2 order by harness`, [f.owner, f.device])).rows.map(row => row.harness)
      assert.ok(identities.includes('claude_code'), 'the execution identities follow the reported harnesses')
      assert.equal((await pool.query('select "leaseExpiresAt" from agent_runs where id=$1', [held])).rows[0].leaseExpiresAt.getTime(), leaseBefore.getTime(), 'no lease is renewed')
    })

    await t.test('device commands go out one at a time and receipts complete them; a removed device gets only its uninstall', async () => {
      const update = randomUUID(), uninstall = randomUUID()
      await pool.query(`insert into device_management_commands (id, "deviceId", kind, "createdAt") values ($1, $2, 'update', now() - interval '1 minute'), ($3, $2, 'uninstall', now())`, [update, f.device, uninstall])
      assert.deepEqual((await (await send({})).json()).deviceCommands, [{ id: update, kind: 'update' }])
      assert.deepEqual((await (await send({ completedDeviceCommands: [update] })).json()).deviceCommands, [{ id: uninstall, kind: 'uninstall' }])
      await pool.query(`update device_tokens set "expiresAt"=now()+interval '1 hour' where id=$1`, [f.tokenId])
      await pool.query(`insert into device_token_devices ("tokenId", "deviceId", "userId") values ($1, $2, $3) on conflict do nothing`, [f.tokenId, f.device, f.owner])
      await pool.query(`update devices set "removedAt"=now() where id=$1`, [f.device])
      const removed = await send({ harnesses: [codex] })
      assert.equal(removed.status, 200)
      assert.deepEqual(await removed.json(), { deviceCommands: [{ id: uninstall, kind: 'uninstall' }] }, 'only the uninstall, no versions or credential')
      const otherRoute = await commands(new Request(`http://127.0.0.1/mikka/v1/devices/${f.device}/commands`, { headers: headers() }), params)
      assert.equal(otherRoute.status, 401, 'a removed device reaches no other route')
      assert.deepEqual(await (await send({ completedDeviceCommands: [uninstall] })).json(), { deviceCommands: [] })
      assert.ok((await pool.query('select "revokedAt" from device_tokens where id=$1', [f.tokenId])).rows[0].revokedAt, 'the uninstall receipt revokes the credential')
    })
  })
})

for (const kind of ['runs', 'repos'] as const) dbTest(`${kind} poll reads current authority, ownership and results in one snapshot`, { timeout: 20_000 }, async t => {
  const [{ createRequestDatabaseScope, pool }, runs, repos] = await Promise.all([
    import('./db'), import('../app/v1/devices/[deviceId]/runs/route'), import('../app/v1/devices/[deviceId]/repos/route'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `poll-${kind}-${randomUUID()}`, foreign = `poll-other-${randomUUID()}`
  const owners = [owner, foreign]
  t.after(async () => {
    await scope.run(async () => {
      await pool.query('DELETE FROM device_repos WHERE "userId"=ANY($1::text[])', [owners])
      await pool.query('DELETE FROM agent_runs WHERE "userId"=ANY($1::text[])', [owners])
      await pool.query('DELETE FROM agents WHERE "userId"=ANY($1::text[])', [owners])
      await pool.query('DELETE FROM device_tokens WHERE "userId"=ANY($1::text[])', [owners])
      await pool.query('DELETE FROM devices WHERE "ownerId"=ANY($1::text[])', [owners])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [owners])
    })
    await scope.close()
  })
  await scope.run(async () => {
    for (const user of owners) await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$1||'@example.invalid',false,now(),now())`, [user])
    const fixture = async () => {
      const device = randomUUID(), tokenId = randomUUID(), credential = `orv_${randomBytes(32).toString('base64url')}`
      await pool.query(`INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,'Poll fixture','local')`, [device, owner])
      await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash","lastUsedAt") VALUES($1,$2,$3,now())', [tokenId, owner, createHash('sha256').update(credential).digest('hex')])
      const request = () => new Request(`http://127.0.0.1/mikka/v1/devices/${device}/${kind}`, { headers: { authorization: `Bearer ${credential}`, ...SESSION, 'x-mikka-client-version': '999.0.0' } })
      return { device, tokenId, request }
    }
    const get = kind === 'runs' ? runs.GET : repos.GET
    const current = await fixture()
    const read = () => get(current.request(), { params: Promise.resolve({ deviceId: current.device }) })
    const result = await measured(async () => {
      const response = await read()
      assert.equal(response.status, 200)
      return response.json()
    })
    assert.deepEqual(result.value, kind === 'runs' ? { runIds: [] } : { repos: [] })
    t.diagnostic(JSON.stringify({ scenario: `${kind}-empty-poll`, statements: result.statements }))
    if (kind === 'runs') {
      const agent = randomUUID(), queued = randomUUID()
      const workspaceId = await seedFixtureWorkspace(pool, owner)
      await pool.query(`INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,'Poll agent','codex')`, [agent, owner])
      await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId","workspaceId",status) VALUES($1,$2,$3,$4,$5,'queued')`, [queued, owner, agent, current.device, workspaceId])
      assert.deepEqual(await (await read()).json(), { runIds: [queued] })
      await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [current.device])
      assert.deepEqual(await (await read()).json(), { runIds: [] }, 'disabled devices receive no queued work')
    } else {
      const repo = randomUUID(), repoPath = 'v2/github.com/fixture/poll-repo'
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath") VALUES($1,$2,$3,$4)', [repo, owner, current.device, repoPath])
      assert.deepEqual(await (await read()).json(), { repos: [{ repoId: repo, name: 'poll-repo', path: repoPath, remoteUrl: null }] })
    }
    for (const change of ['revoked', 'expired', 'removed', 'foreign-owner'] as const) {
      const f = await fixture()
      const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<{ deviceId: string }>()
      // The wrapped handler reads params after real initial authentication and
      // waits for this promise before any business read.
      const pending = get(f.request(), { get params() { entered.resolve(); return gate.promise } })
      try {
        await Promise.race([entered.promise, pending.then(() => { throw new Error('Poll completed before the params barrier') })])
        if (change === 'revoked') await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [f.tokenId])
        else if (change === 'expired') await pool.query(`UPDATE device_tokens SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [f.tokenId])
        else if (change === 'removed') await pool.query('UPDATE devices SET "removedAt"=now() WHERE id=$1', [f.device])
        else await pool.query('UPDATE devices SET "ownerId"=$2 WHERE id=$1', [f.device, foreign])
      } finally { gate.resolve({ deviceId: f.device }) }
      const response = await pending
      assert.equal(response.status, change === 'revoked' || change === 'expired' ? 401 : 404, `${change} between authentication and the snapshot is refused`)
      const body = await response.json()
      assert.equal('runIds' in body || 'repos' in body, false, 'no business data accompanies a refused read')
    }
    assert.equal(result.statements, 2, 'one fresh authentication and one authority/owner/result snapshot')
  })
})

dbTest('initial claim repository handoff removes a real cloud repos request without increasing SQL, rows or response bytes', async t => {
  const [{ createRequestDatabaseScope, pool }, { GET }, { readRepositorySettings }] = await Promise.all([
    import('./db'), import('../app/v1/devices/[deviceId]/repos/route'), import('./device-repositories'),
  ])
  const { Client } = await import('pg')
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = 'repository-handoff-' + randomUUID(), device = randomUUID(), agent = randomUUID(), run = randomUUID(), repo = randomUUID(), workspace = randomUUID()
  const token = 'orv_' + randomBytes(32).toString('base64url'), remote = 'https://github.com/fixture/repository.git'
  type Meter = { queries: number; sqlBytes: number; resultRows: number; sentBytes: number; receivedBytes: number }
  type Channel = { write:(chunk:Uint8Array|string,...args:unknown[])=>boolean; on:(event:'data',fn:(data:Buffer)=>void)=>unknown; off:(event:'data',fn:(data:Buffer)=>void)=>unknown }
  let active: Meter | undefined
  const channels = new Map<Channel,{write:Channel['write'];receive:(data:Buffer)=>void}>()
  const original = Client.prototype.query
  Client.prototype.query = new Proxy(original,{apply(target,client,args) {
    if (active) {
      const meter = active
      meter.queries++
      meter.sqlBytes += Buffer.byteLength(typeof args[0] === 'string' ? args[0] : args[0].text)
      const channel = (client as unknown as {connection:{stream:Channel}}).connection.stream
      if (!channels.has(channel)) {
        const write = channel.write
        const receive = (data:Buffer) => { if(active)active.receivedBytes += data.length }
        channel.write = function(chunk,...rest) { if(active)active.sentBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength; return write.call(this,chunk,...rest) }
        channel.on('data',receive);channels.set(channel,{write,receive})
      }
      const observed = (result:unknown) => {
        const results = Array.isArray(result) ? result : [result]
        for(const value of results)if(value && typeof value==='object' && 'rows' in value && Array.isArray(value.rows))meter.resultRows += value.rows.length
      }
      const callback = args.at(-1)
      if(typeof callback==='function')args[args.length-1]=(error:unknown,result:unknown)=>{observed(result);callback(error,result)}
      const result = Reflect.apply(target,client,args)
      return result && typeof result.then==='function' ? result.then((value:unknown)=>{observed(value);return value}) : result
    }
    return Reflect.apply(target,client,args)
  }})
  const measure = async<T>(fn:()=>Promise<T>) => {
    const meter:Meter={queries:0,sqlBytes:0,resultRows:0,sentBytes:0,receivedBytes:0}
    active=meter
    try {return {meter,value:await fn()}}finally{active=undefined}
  }
  try {
    await scope.run(async()=>{
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$1||\'@example.invalid\',false,now(),now())',[owner])
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Task fixture\',\'cloud\')',[device,owner])
      await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,\'Fixture\',\'codex\')',[agent,owner])
      await pool.query('INSERT INTO agent_runs(id,"userId","agentId","deviceId",status) VALUES($1,$2,$3,$4,\'queued\')',[run,owner,agent,device])
      await pool.query('INSERT INTO thread_machines("runId","ownerId","workspaceId","deviceId","snapshotId","operationId",state) VALUES($1,$2,$3,$4,\'fixture\',$5,\'starting\')',[run,owner,workspace,device,randomUUID()])
      await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt","lastUsedAt") VALUES($1,$2,$3,$4,$5,now()+interval \'1 day\',now())',[randomUUID(),owner,createHash('sha256').update(token).digest('hex'),device,workspace])
      await pool.query('INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES($1,$2,$3,\'v2/github.com/fixture/repository\',$4)',[repo,device,owner,remote])
      const request=()=>new Request('http://127.0.0.1/v1/devices/'+device+'/repos',{headers:{authorization:'Bearer '+token,'x-mikka-device-session': '1', 'x-mikka-client-version':'999.0.0'}})
      const get=()=>GET(request(),{params:Promise.resolve({deviceId:device})})
      // Warm this isolated connection before measuring protocol messages. No production IO.
      assert.equal((await get()).status,200)
      for(const scenario of ['missing','complete','unicode'] as const) {
        await pool.query('DELETE FROM repository_settings WHERE "userId"=$1',[owner])
        if(scenario!=='missing')await pool.query('INSERT INTO repository_settings("userId","remoteKey",setup,"networkAllow") VALUES($1,\'v2/github.com/fixture/repository\',$2,$3)',[owner,JSON.stringify({approved:true,copyFiles:['.env.local'],command:scenario==='unicode'?'echo '+ '测试'.repeat(300):'npm ci'}),JSON.stringify(['registry.npmjs.org'])])
        const old=await measure(async()=>{
          await readRepositorySettings(owner,remote) // the existing claim read, unchanged
          const response=await get();assert.equal(response.status,200)
          return await response.text()
        })
        const next=await measure(()=>readRepositorySettings(owner,remote))
        if(scenario!=='missing')assert(next.value?.setup, 'the complete/Unicode fixtures must read their real setup row')
        const selected=JSON.parse(old.value).repos[0]
        assert.deepEqual(selected.setup,next.value?.setup ?? undefined)
        assert.deepEqual(selected.networkAllow,next.value?.networkAllow ?? undefined)
        const originalClaim={runId:run,repoId:repo,remoteUrl:remote}
        const oldResponseBytes=Buffer.byteLength(JSON.stringify(originalClaim))+Buffer.byteLength(old.value)
        const nextResponseBytes=Buffer.byteLength(JSON.stringify({...originalClaim,repo:selected}))
        assert(next.meter.queries<old.meter.queries)
        assert(next.meter.resultRows<old.meter.resultRows)
        assert(next.meter.sentBytes<old.meter.sentBytes)
        assert(next.meter.receivedBytes<old.meter.receivedBytes)
        assert(nextResponseBytes<=oldResponseBytes)
        t.diagnostic(JSON.stringify({metric:'initial_repository_task_delta',scenario,unchangedTaskPrefixSuffixExcluded:true,
          protocol:'PostgreSQL messages, excluding TCP/TLS/connect; HTTP JSON bodies separately',original:old.meter,candidate:next.meter,
          oldResponseBytes,nextResponseBytes,sqlDelta:next.meter.queries-old.meter.queries,
          rowDelta:next.meter.resultRows-old.meter.resultRows,wireDelta:next.meter.sentBytes+next.meter.receivedBytes-old.meter.sentBytes-old.meter.receivedBytes,
          responseBodyDelta:nextResponseBytes-oldResponseBytes}))
      }
      await pool.query('UPDATE device_repos SET "repoPath"=$2,"remoteUrl"=NULL WHERE id=$1', [repo, '/workspace/repository'])
      const hosted = await (await get()).json()
      assert.deepEqual(hosted.repos, [{ repoId: repo, name: 'repository', path: '/workspace/repository', remoteUrl: null }], 'a hosted worker keeps its provisioned directory without a remote')
      assert.equal(await readRepositorySettings('different-owner',remote),null)
    })
  } finally {
    active=undefined;Client.prototype.query=original
    for(const[channel,entry]of channels){channel.write=entry.write;channel.off('data',entry.receive)}
    await scope.run(async()=>{
      await pool.query('DELETE FROM device_tokens WHERE "userId"=$1',[owner])
      await pool.query('DELETE FROM agent_runs WHERE "userId"=$1',[owner])
      await pool.query('DELETE FROM agents WHERE "userId"=$1',[owner])
      await pool.query('DELETE FROM repository_settings WHERE "userId"=$1',[owner])
      await pool.query('DELETE FROM device_repos WHERE "userId"=$1',[owner])
      await pool.query('DELETE FROM devices WHERE "ownerId"=$1',[owner])
      await pool.query('DELETE FROM "user" WHERE id=$1',[owner])
    })
    await scope.close()
  }
})

dbTest('an owned device lists authorized active thread roots from the current workspace only', async t => {
  const [{ createRequestDatabaseScope, pool }, { activeThreadsOnOwnedDevice }] = await Promise.all([
    import('./db'), import('./conversation-directory'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = 'device-threads-' + randomUUID(), peer = 'device-peer-' + randomUUID()
  const owners = [owner, peer]
  t.after(async () => {
    await scope.run(async () => {
      await pool.query('DELETE FROM agent_runs WHERE "userId"=ANY($1)', [owners])
      await pool.query('DELETE FROM agents WHERE "userId"=ANY($1)', [owners])
      await pool.query('DELETE FROM devices WHERE "ownerId"=ANY($1)', [owners])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [owners])
    })
    await scope.close()
  })
  await scope.run(async () => {
    for (const user of owners) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,false,now(),now())', [user,user+'@example.invalid'])
    const home = await seedFixtureWorkspace(pool, owner), other = await seedFixtureWorkspace(pool, peer)
    const team = await seedFixtureWorkspace(pool, owner, 'team')
    const device = randomUUID(), spare = randomUUID(), agent = randomUUID()
    await pool.query(`INSERT INTO devices(id,"ownerId",name,kind) VALUES ($1,$3,'mine','local'),($2,$3,'spare','local')`, [device,spare,owner])
    await pool.query(`INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,'device test','codex')`, [agent,owner])
    const seedRun = async (status: string, workspace = home, machine = device, previous?: string) => {
      const id = randomUUID()
      await pool.query(`INSERT INTO agent_runs(id,"userId","workspaceId","agentId","deviceId",status,"continuesRunId")
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [id,owner,workspace,agent,machine,status,previous ?? null])
      return id
    }
    const root = await seedRun('succeeded', home, spare)
    await seedRun('waiting_input', home, device, root)
    const terminal = await seedRun('running')
    await seedRun('succeeded', home, device, terminal)
    const moved = await seedRun('running')
    await seedRun('running', home, spare, moved)
    const queued = await seedRun('queued')
    const replaced = await seedRun('succeeded', home, spare)
    await seedRun('running', home, device, replaced)
    await pool.query('UPDATE agent_runs SET "threadReplacedBy"=$2 WHERE id=$1', [replaced, root])
    await seedRun('running', team)
    const read = (actor: string, workspace: string, after?: string) => activeThreadsOnOwnedDevice(pool, actor, workspace, device, after)
    const threads = [{id: root, status: 'waiting_input'}, {id: queued, status: 'queued'}].sort((a,b) => a.id.localeCompare(b.id))
    assert.deepEqual(await read(owner,home), {threads, cursor:null})
    assert.deepEqual(await read(owner,home,threads[0].id), {threads:threads.slice(1), cursor:null})
    assert.equal(await read(peer,other), null)
    assert.equal(await read(peer,home), null)
    await pool.query('UPDATE devices SET "removedAt"=now() WHERE id=$1', [device])
    assert.equal(await read(owner,home), null)
  })
})
