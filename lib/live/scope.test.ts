import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceGatewayTicketValid } from '../device-gateway-ticket'
import { liveInvalidation, liveInvalidations } from './events'
import { liveChannelId, liveGatewayConfig, liveTicket } from './scope'

const workspace = '19df8afd-0f8c-4c6b-bc9c-20df0b046a72'
const otherWorkspace = 'f143a678-070f-474b-803b-0bb119a88410'
const config = { url: 'https://gateway.test', secret: 'local-live-test-secret' }

test('owner and workspace are both part of the signed channel; device tickets are another domain', () => {
  const scope = { ownerId: 'owner', workspaceId: workspace }
  const channel = liveChannelId(scope)
  const ticket = liveTicket(scope, config)
  assert.equal(deviceGatewayTicketValid(`live:${channel}`, ticket.protocol, config.secret), true)
  for (const candidate of [
    liveChannelId({ ownerId: 'peer', workspaceId: workspace }),
    liveChannelId({ ownerId: 'owner', workspaceId: otherWorkspace }),
  ]) assert.equal(deviceGatewayTicketValid(`live:${candidate}`, ticket.protocol, config.secret), false)
  assert.equal(deviceGatewayTicketValid(channel, ticket.protocol, config.secret), false)
  assert.equal(deviceGatewayTicketValid(`live:${channel}`, ticket.protocol, config.secret, ticket.expiresAt), false)
  assert.equal(new URL(ticket.url).search, '')
  assert.equal(new URL(ticket.url).protocol, 'wss:')
  assert.equal(ticket.url.includes(ticket.protocol), false)
})

test('the wire format refuses data, credentials and arbitrary entity kinds', () => {
  const value = { kind: 'factory_task', id: workspace }
  assert.deepEqual(liveInvalidation(value), value)
  for (const invalid of [null, [], { ...value, prompt: 'private' }, { ...value, token: 'private' }, { kind: 'user', id: workspace }, { ...value, id: 'not-an-id' }]) {
    assert.equal(liveInvalidation(invalid), null)
  }
  assert.equal(liveInvalidations([]), null)
  assert.equal(liveInvalidations(Array(17).fill(value)), null)
})

test('gateway configuration uses the existing origin and refuses credential-bearing URLs', () => {
  assert.equal(liveGatewayConfig({ DEVICE_GATEWAY_URL: 'https://gateway.test' }), null)
  assert.equal(liveGatewayConfig({ DEVICE_GATEWAY_URL: 'https://user:password@gateway.test', DEVICE_GATEWAY_PUSH_SECRET: config.secret }), null)
  assert.equal(liveGatewayConfig({ DEVICE_GATEWAY_URL: 'file:///tmp/gateway', DEVICE_GATEWAY_PUSH_SECRET: config.secret }), null)
})
