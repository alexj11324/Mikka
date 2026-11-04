import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'

const databaseUrl = process.env.E2E_DATABASE_URL
const eligible = databaseUrl && disposableDatabase(process.env, databaseUrl)
if (!eligible && process.env.REQUIRE_DB === '1') throw new Error('Gateway presence acceptance requires isolated loopback *_e2e Postgres')

test('real Postgres: idle gateway presence drives dispatch, device selection and post-commit uninstall', { skip: !eligible }, async t => {
  const [{ createRequestDatabaseScope, pool }, { targetDevice }, { poolDevices }, { removeOwnedDevice }] = await Promise.all([
    import('./db'), import('./dispatch-target'), import('./model-order'), import('./device-removal'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-gateway-presence-${randomUUID()}`
  const deviceId = randomUUID(), agentId = randomUUID(), tokenId = randomUUID()
  const stale = new Date(Date.now() - 3_600_000)
  let gatewayOnline = true
  let pushCount = 0
  const pending: Promise<unknown>[] = []
  const symbol = Symbol.for('@vercel/request-context')
  const globals = globalThis as unknown as Record<symbol, unknown>
  const beforeContext = globals[symbol]
  globals[symbol] = { get: () => ({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) }) }
  const priorEnv = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer isolated-presence-db-secret')
    if (request.url === `/v1/devices/${deviceId}/status`) {
      response.end(JSON.stringify({ online: gatewayOnline, lastSeenAt: new Date().toISOString() }))
      return
    }
    assert.equal(request.url, `/v1/devices/${deviceId}/push`)
    // A separate connection must see the commit before the signal can arrive.
    const committed = await scope.run(() => pool.query(`SELECT d."removedAt",c.kind FROM devices d
      JOIN device_management_commands c ON c."deviceId"=d.id WHERE d.id=$1`, [deviceId]))
    assert.ok(committed.rows[0]?.removedAt)
    assert.equal(committed.rows[0]?.kind, 'uninstall')
    pushCount++
    response.writeHead(204).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${address.port}`
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-presence-db-secret'
  t.after(async () => {
    await Promise.all(pending)
    globals[symbol] = beforeContext
    if (priorEnv.url === undefined) delete process.env.DEVICE_GATEWAY_URL
    else process.env.DEVICE_GATEWAY_URL = priorEnv.url
    if (priorEnv.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET
    else process.env.DEVICE_GATEWAY_PUSH_SECRET = priorEnv.secret
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await scope.run(async () => {
      await pool.query('DELETE FROM device_credential_revocations WHERE "ownerId"=$1', [owner])
      await pool.query('DELETE FROM device_token_devices WHERE "deviceId"=$1', [deviceId])
      await pool.query('DELETE FROM device_tokens WHERE "userId"=$1', [owner])
      await pool.query('DELETE FROM device_management_commands WHERE "deviceId"=$1', [deviceId])
      await pool.query('DELETE FROM agents WHERE "userId"=$1', [owner])
      await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [owner])
      await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
    })
    await scope.close()
  })
  await scope.run(async () => {
    await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt")
      VALUES ($1,'Gateway presence fixture',$1||'@example.invalid',false,now(),now())`, [owner])
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses)
      VALUES ($1,$2,'Idle gateway fixture','local',true,$3,'[{"harness":"codex","installed":true}]')`, [deviceId, owner, stale])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex','Gateway fixture')`, [agentId, owner, deviceId])
    await pool.query(`INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)`, [tokenId, owner, randomUUID()])
    await pool.query(`INSERT INTO device_token_devices ("tokenId","deviceId","userId") VALUES ($1,$2,$3)`, [tokenId, deviceId, owner])

    const target = await targetDevice(pool, owner, deviceId)
    assert.ok('agentId' in target)
    assert.equal(target.agentId, agentId)
    assert.equal((await poolDevices(pool, owner))[0]?.online, true)
    assert.deepEqual(await targetDevice(pool, 'foreign-owner', deviceId), { error: 'notFound' })
    gatewayOnline = false
    assert.deepEqual(await targetDevice(pool, owner, deviceId), { error: 'unavailable' })
    assert.equal((await poolDevices(pool, owner))[0]?.online, false)
    gatewayOnline = true
    const heartbeat = (await pool.query('SELECT "lastSeenAt" FROM devices WHERE id=$1', [deviceId])).rows[0].lastSeenAt
    assert.equal(heartbeat.getTime(), stale.getTime(), 'presence reads never write Neon heartbeats')

    assert.deepEqual(await removeOwnedDevice(owner, deviceId), { id: deviceId, revokedTokens: 0, uninstall: 'queued' })
    await Promise.all(pending)
    assert.equal(pushCount, 1)
    const credential = (await pool.query('SELECT "revokedAt","expiresAt" FROM device_tokens WHERE id=$1', [tokenId])).rows[0]
    assert.equal(credential.revokedAt, null, 'online uninstall keeps only the existing receipt grace')
    assert.ok(credential.expiresAt instanceof Date)
  })
})
