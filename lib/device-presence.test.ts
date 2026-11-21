import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { deviceIsOnline, deviceOnlineStates, deviceSessionOpenSql, gatewayDeviceOnline } from './device-presence'
import { targetDevice } from './dispatch-target'

// These cases mean "no gateway" when DEVICE_GATEWAY_URL is absent. A community installation with
// BETTER_AUTH_URL and BETTER_AUTH_SECRET would select its built-in gateway instead (lib/builtin-gateway/config.ts),
// which CI exports for database suites, so the file runs without that origin.
delete process.env.BETTER_AUTH_URL

const id = '11111111-1111-4111-8111-111111111111'
const opened = new Date('2026-11-17T10:00:00.000Z')
const online = { id, sessionOpenedAt: opened, sessionClosedAt: null }

async function gateway(handler: (request: IncomingMessage, response: ServerResponse) => void, run: () => Promise<void>) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${address.port}`
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-test-gateway-secret'
  try { await run() } finally {
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL
    else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET
    else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

test('a device is online while the session it opened last is not closed, whatever time has passed', () => {
  assert.equal(deviceIsOnline(online), true)
  assert.equal(deviceIsOnline({ sessionOpenedAt: '2020-01-01T00:00:00.000Z', sessionClosedAt: null }), true, 'no heartbeat clock: an old open session is still open')
  assert.equal(deviceIsOnline({ sessionOpenedAt: null, sessionClosedAt: null }), false, 'never connected')
  assert.equal(deviceIsOnline({ sessionOpenedAt: opened, sessionClosedAt: new Date(opened.getTime() + 1) }), false)
  assert.equal(deviceIsOnline({ sessionOpenedAt: opened, sessionClosedAt: opened }), false, 'a close at the same instant ends it')
  assert.equal(deviceIsOnline({ sessionOpenedAt: opened, sessionClosedAt: new Date(opened.getTime() - 1) }), true, 'an older close belongs to a replaced socket')
})

test('a page reads presence from its rows, with no call to the gateway', async () => {
  let reads = 0
  await gateway((_request, response) => { reads++; response.end('{"online":false}') }, async () => {
    const states = deviceOnlineStates([online, { id: '22222222-2222-4222-8222-222222222222', sessionOpenedAt: null, sessionClosedAt: null }])
    assert.deepEqual([...states], [[id, true], ['22222222-2222-4222-8222-222222222222', false]])
  })
  assert.equal(reads, 0)
})

test('the SQL predicate is the same rule', () => {
  assert.equal(deviceSessionOpenSql('d'), '(d."sessionOpenedAt" IS NOT NULL AND (d."sessionClosedAt" IS NULL OR d."sessionClosedAt" < d."sessionOpenedAt"))')
})

test('the run-recovery backstop asks the gateway with its secret and never invents an answer', async () => {
  let reply: unknown = { online: false, lastSeenAt: new Date().toISOString() }
  let status = 200
  await gateway((request, response) => {
    assert.equal(request.url, `/v1/devices/${id}/status`)
    assert.equal(request.headers.authorization, 'Bearer isolated-test-gateway-secret')
    response.statusCode = status
    response.end(JSON.stringify(reply))
  }, async () => {
    assert.equal(await gatewayDeviceOnline(id), false)
    reply = { online: true }
    assert.equal(await gatewayDeviceOnline(id), true)
    reply = { online: 'yes' }
    assert.equal(await gatewayDeviceOnline(id), null, 'malformed: unknown, not offline')
    status = 503
    assert.equal(await gatewayDeviceOnline(id), null)
    delete process.env.DEVICE_GATEWAY_URL
    assert.equal(await gatewayDeviceOnline(id), null, 'no gateway: unknown')
  })
})

test('the backstop does not follow redirects with its server credential', async () => {
  let reads = 0
  await gateway((_request, response) => { reads++; response.writeHead(302, { location: '/unexpected' }).end() }, async () => {
    assert.equal(await gatewayDeviceOnline(id), null)
    assert.equal(reads, 1)
  })
})

test('an owned device with an open session can receive a dispatch; closed, foreign and disabled devices cannot', async () => {
  const device = { ...online, enabled: true, name: 'idle computer', harnesses: [{ harness: 'codex', installed: true }] } as { id: string; enabled: boolean; name: string; harnesses: unknown[]; sessionOpenedAt: Date; sessionClosedAt: Date | null }
  let exists = true
  const queries: string[] = []
  const database = { query: async (sql: string) => {
    queries.push(sql)
    return { rows: sql.includes('FROM devices') ? exists ? [device] : [] : [{ id: 'owned-agent' }] }
  } } as unknown as Parameters<typeof targetDevice>[0]
  const result = await targetDevice(database, 'owner', id)
  assert.ok('deviceId' in result)
  assert.equal(result.deviceId, id)
  assert.ok(queries.every(sql => sql.startsWith('SELECT ')), 'presence never writes')
  device.sessionClosedAt = new Date(opened.getTime() + 1)
  assert.deepEqual(await targetDevice(database, 'owner', id), { error: 'unavailable' })
  device.sessionClosedAt = null
  exists = false
  assert.deepEqual(await targetDevice(database, 'other-owner', id), { error: 'notFound' })
  exists = true
  device.enabled = false
  assert.deepEqual(await targetDevice(database, 'owner', id), { error: 'unavailable' })
})
