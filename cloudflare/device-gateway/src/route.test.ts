import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceGatewayTicket } from '../../../lib/device-gateway-ticket'
import { handleRequest, type DeviceSessionStub, type GatewayEnv } from './route'

const secret = 'gateway-test-secret'
const deviceId = '6f1c2b8e-2a8e-4c39-9d1a-3b5d7c9e1f20'

function env(stub: Partial<DeviceSessionStub>): GatewayEnv {
  const session: DeviceSessionStub = {
    notify: async () => {},
    notifyLive: async () => {},
    revokeLive: async () => {},
    status: async () => ({ online: false, lastSeenAt: null }),
    fetch: async () => new Response(null),
    watchPresence: async () => ({ accepted: true, changed: false }),
    unwatchPresence: async () => {},
    presenceChanged: async () => [],
    ...stub,
  }
  return { GATEWAY_PUSH_SECRET: secret, DEVICE_SESSION: { getByName: () => session } }
}

test('a push with the gateway secret wakes that device and carries no body', async () => {
  let notified = 0
  const response = await handleRequest(new Request(`https://gateway.test/v1/devices/${deviceId}/push`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}` },
  }), env({ notify: async () => { notified += 1 }, fetch: async () => new Response(null) }))
  assert.equal(response.status, 204)
  assert.equal(notified, 1)
  assert.equal(await response.text(), '')
})

test('a push without the secret does not wake the device', async () => {
  let notified = 0
  const response = await handleRequest(new Request(`https://gateway.test/v1/devices/${deviceId}/push`, { method: 'POST' }), env({
    notify: async () => { notified += 1 }, fetch: async () => new Response(null),
  }))
  assert.equal(response.status, 401)
  assert.equal(notified, 0)
})

test('the socket is refused until the ticket matches the device', async () => {
  const ticket = deviceGatewayTicket(deviceId, secret)
  let fetched = 0
  const stub = { fetch: async () => { fetched += 1; return new Response(null, { status: 200 }) } }
  const denied = await handleRequest(new Request(`https://gateway.test/v1/devices/${deviceId}/socket`, {
    headers: { upgrade: 'websocket' },
  }), env(stub))
  assert.equal(denied.status, 401)
  const opened = await handleRequest(new Request(`https://gateway.test/v1/devices/${deviceId}/socket`, {
    headers: { upgrade: 'websocket', 'sec-websocket-protocol': ticket.protocol },
  }), env(stub))
  assert.equal(opened.status, 200)
  assert.equal(fetched, 1)
})

test('the edge forwards only the authenticated protocol from an offered list', async () => {
  const ticket = deviceGatewayTicket(deviceId, secret)
  let selected: string | null = null
  const response = await handleRequest(new Request(`https://gateway.test/v1/devices/${deviceId}/socket`, {
    headers: { upgrade: 'websocket', 'sec-websocket-protocol': `other-protocol, ${ticket.protocol}` },
  }), env({ fetch: async request => {
    selected = request.headers.get('sec-websocket-protocol')
    return new Response(null)
  } }))
  assert.equal(response.status, 200)
  assert.equal(selected, ticket.protocol)
})

test('status is uncached and available only to the authenticated server', async () => {
  const presence = { online: true, lastSeenAt: new Date().toISOString() }
  let queried = 0
  const gateway = env({ status: async () => { queried += 1; return presence } })
  for (const authorization of ['', `Bearer ${deviceGatewayTicket(deviceId, secret).protocol}`, 'Bearer wrong-secret']) {
    const response = await handleRequest(new Request(`https://gateway.test/v1/devices/${deviceId}/status`, {
      headers: { authorization },
    }), gateway)
    assert.equal(response.status, 401)
  }
  assert.equal(queried, 0)
  const response = await handleRequest(new Request(`https://gateway.test/v1/devices/${deviceId}/status`, {
    headers: { authorization: `Bearer ${secret}` },
  }), gateway)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), presence)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(queried, 1)
})

test('a refused status request does not create or wake a Durable Object', async () => {
  const gateway: GatewayEnv = {
    GATEWAY_PUSH_SECRET: secret,
    DEVICE_SESSION: { getByName: () => { throw new Error('unauthorized request reached a session') } },
  }
  const response = await handleRequest(new Request(`https://gateway.test/v1/devices/${deviceId}/status`), gateway)
  assert.equal(response.status, 401)
})
