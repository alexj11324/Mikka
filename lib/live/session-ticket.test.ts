import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceGatewayTicket } from '../device-gateway-ticket'
import { readSessionLiveTicket, sessionLiveTicket } from './session-ticket'

const channel = 'a'.repeat(64)
const secret = 'isolated-session-live-ticket-secret'
const now = 1_800_000_000_000

test('a live ticket binds the exact channel, session, signing key and expiry', () => {
  const ticket = sessionLiveTicket(channel, 'session-one', secret, now)
  assert.deepEqual(readSessionLiveTicket(channel, `other, ${ticket.protocol}`, secret, now), {
    ...ticket, sessionId: 'session-one',
  })
  assert.ok(ticket.expiresAt > now && ticket.expiresAt <= now + 300_000)
  assert.equal(readSessionLiveTicket('b'.repeat(64), ticket.protocol, secret, now), null)
  assert.equal(readSessionLiveTicket(channel, ticket.protocol, 'different-key', now), null)
  assert.equal(readSessionLiveTicket(channel, ticket.protocol, secret, ticket.expiresAt), null)
  assert.ok(readSessionLiveTicket(channel, ticket.protocol, secret, ticket.expiresAt - 1))
  const other = sessionLiveTicket(channel, 'session-two', secret, now)
  assert.notEqual(other.protocol, ticket.protocol)
  assert.equal(readSessionLiveTicket(channel, other.protocol, secret, now)?.sessionId, 'session-two')
})

test('a forged or legacy live capability cannot impersonate a session-bound ticket', () => {
  const ticket = sessionLiveTicket(channel, 'session-one', secret, now)
  const tampered = ticket.protocol.slice(0, -1) + (ticket.protocol.endsWith('0') ? '1' : '0')
  for (const protocol of ['', 'mikka-ticket-invalid', tampered,
    deviceGatewayTicket(`live:${channel}`, secret, now).protocol,
    deviceGatewayTicket('session-one', secret, now).protocol]) {
    assert.equal(readSessionLiveTicket(channel, protocol, secret, now), null)
  }
})
