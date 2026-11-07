import assert from 'node:assert/strict'
import test from 'node:test'
import { bearerMatches, deviceGatewayTicket, deviceGatewayTicketValid } from './device-gateway-ticket'

const secret = 'gateway-test-secret'
const deviceId = '6f1c2b8e-2a8e-4c39-9d1a-3b5d7c9e1f20'

test('a ticket opens only its own device and only before it expires', () => {
  const now = Date.parse('2026-11-03T20:00:00Z')
  const ticket = deviceGatewayTicket(deviceId, secret, now)
  assert.equal(deviceGatewayTicketValid(deviceId, ticket.protocol, secret, now + 1_000), true)
  assert.equal(deviceGatewayTicketValid(deviceId, ticket.protocol, secret, now + 301_000), false)
  assert.equal(deviceGatewayTicketValid('other-device', ticket.protocol, secret, now + 1_000), false)
  assert.equal(deviceGatewayTicketValid(deviceId, ticket.protocol, 'other-secret', now + 1_000), false)
  assert.equal(deviceGatewayTicketValid(deviceId, `echo, ${ticket.protocol}`, secret, now + 1_000), true)
})

test('push authorization compares the whole bearer header', () => {
  assert.equal(bearerMatches(`Bearer ${secret}`, secret), true)
  assert.equal(bearerMatches('Bearer gateway-test-secre', secret), false)
  assert.equal(bearerMatches(null, secret), false)
  assert.equal(bearerMatches(`Bearer ${secret}`, ''), false)
  assert.equal(bearerMatches(`Bearer ${'é'.repeat(secret.length)}`, secret), false, 'equal character counts need not have equal byte lengths')
})
