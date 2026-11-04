import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { deviceIsOnline, deviceOnlineStates } from './device-presence'
import { targetDevice } from './dispatch-target'

const id = '11111111-1111-4111-8111-111111111111'
const stale = { id, lastSeenAt: new Date(Date.now() - 3_600_000) }

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

test('an idle device stays available after its HTTP heartbeat expires, without writing the heartbeat', async () => {
  let reads = 0
  await gateway((request, response) => {
    reads++
    assert.equal(request.url, `/v1/devices/${id}/status`)
    assert.equal(request.headers.authorization, 'Bearer isolated-test-gateway-secret')
    response.end(JSON.stringify({ online: true, lastSeenAt: new Date().toISOString() }))
  }, async () => {
    assert.equal(await deviceIsOnline(stale), true)
    assert.equal(stale.lastSeenAt.getTime() < Date.now() - 60_000, true)
    assert.equal(reads, 1)
  })
})

test('fresh legacy heartbeats do not call the gateway; page duplicates only read once', async () => {
  let reads = 0
  await gateway((_request, response) => {
    reads++
    response.end(JSON.stringify({ online: true, lastSeenAt: new Date().toISOString() }))
  }, async () => {
    assert.equal(await deviceIsOnline({ id, lastSeenAt: new Date() }), true)
    assert.equal(reads, 0)
    assert.equal((await deviceOnlineStates([stale, stale])).get(id), true)
    assert.equal(reads, 1)
  })
})

test('offline, expired, malformed and unavailable gateway responses never invent online state', async () => {
  let reply: unknown = { online: false, lastSeenAt: new Date().toISOString() }
  let status = 200
  await gateway((_request, response) => { response.statusCode = status; response.end(JSON.stringify(reply)) }, async () => {
    assert.equal(await deviceIsOnline(stale), false)
    reply = { online: true, lastSeenAt: new Date(Date.now() - 91_000).toISOString() }
    assert.equal(await deviceIsOnline(stale), false)
    reply = { online: true, lastSeenAt: new Date(Date.now() + 3_600_000).toISOString() }
    assert.equal(await deviceIsOnline(stale), false)
    reply = { online: true }
    assert.equal(await deviceIsOnline(stale), false)
    reply = { online: true, lastSeenAt: new Date().toISOString() }
    status = 503
    assert.equal(await deviceIsOnline(stale), false)
    delete process.env.DEVICE_GATEWAY_URL
    assert.equal(await deviceIsOnline(stale), false)
  })
})

test('presence does not follow redirects with its server credential', async () => {
  let reads = 0
  await gateway((_request, response) => {
    reads++
    response.writeHead(302, { location: `/unexpected` }).end()
  }, async () => {
    assert.equal(await deviceIsOnline(stale), false)
    assert.equal(reads, 1)
  })
})

test('a gateway-online owned device can receive a dispatch after one hour idle; foreign and disabled devices cannot', async () => {
  let reads = 0
  await gateway((_request, response) => {
    reads++
    response.end(JSON.stringify({ online: true, lastSeenAt: new Date().toISOString() }))
  }, async () => {
    const device = { ...stale, enabled: true, name: 'idle computer', harnesses: [{ harness: 'codex', installed: true }] }
    let exists = true
    const queries: string[] = []
    const database = { query: async (sql: string) => {
      queries.push(sql)
      return { rows: sql.includes('FROM devices') ? exists ? [device] : [] : [{ id: 'owned-agent' }] }
    } } as unknown as Parameters<typeof targetDevice>[0]
    const result = await targetDevice(database, 'owner', id)
    assert.ok('deviceId' in result)
    assert.equal(result.deviceId, id)
    assert.equal(reads, 1)
    assert.ok(queries.every(sql => sql.startsWith('SELECT ')), 'presence never writes a synthetic heartbeat')
    exists = false
    assert.deepEqual(await targetDevice(database, 'other-owner', id), { error: 'notFound' })
    exists = true
    device.enabled = false
    assert.deepEqual(await targetDevice(database, 'owner', id), { error: 'unavailable' })
    assert.equal(reads, 1, 'authorization and enabled state are checked before gateway access')
  })
})
