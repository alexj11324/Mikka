import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceGatewayTicket } from '../../../lib/device-gateway-ticket'
import { handleRequest, type DeviceSessionStub, type GatewayEnv } from './route'

const secret = 'gateway-test-secret'
const deviceId = '6f1c2b8e-2a8e-4c39-9d1a-3b5d7c9e1f20'

function env(stub: DeviceSessionStub): GatewayEnv {
  return { GATEWAY_PUSH_SECRET: secret, DEVICE_SESSION: { getByName: () => stub } }
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
  const stub: DeviceSessionStub = { notify: async () => {}, fetch: async () => { fetched += 1; return new Response(null, { status: 200 }) } }
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
