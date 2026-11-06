import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { devicePresenceGrant, readDevicePresenceGrant } from './device-presence-grant'
import { liveChannelId } from './live/scope'
import { deviceGatewayTicket, deviceGatewayTicketValid } from './device-gateway-ticket'
import { presenceCommand, presenceReply, PRESENCE_GRANT_MS, PRESENCE_MAX_DEVICES, type PresenceDevice } from './live/presence'

const secret = 'presence-test-secret', now = 1_800_000_000_000
const scope = { ownerId: 'owner', workspaceId: '10000000-0000-4000-8000-000000000001' }
const channel = liveChannelId(scope)
const device = '20000000-0000-4000-8000-000000000001'
const devices: PresenceDevice[] = [[device, true, 0]]

test('a presence proof binds the authorized devices to the exact owner/home and expiry', () => {
  const proof = devicePresenceGrant(scope, devices, secret, now)!
  assert.deepEqual(readDevicePresenceGrant(proof.token, channel, secret, now), { channel, home: scope.workspaceId, devices, expiresAt: now + PRESENCE_GRANT_MS })
  assert.equal(readDevicePresenceGrant(proof.token, liveChannelId({ ...scope, ownerId: 'peer' }), secret, now), null)
  assert.equal(readDevicePresenceGrant(proof.token, liveChannelId({ ...scope, workspaceId: device }), secret, now), null)
  assert.equal(readDevicePresenceGrant(proof.token, channel, 'another-secret', now), null)
  assert.equal(readDevicePresenceGrant(proof.token, channel, secret, proof.expiresAt), null)
  assert.equal(readDevicePresenceGrant(proof.token, channel, secret, now - PRESENCE_GRANT_MS), null)
  assert.equal(readDevicePresenceGrant(proof.token.replace(/.$/, proof.token.endsWith('0') ? '1' : '0'), channel, secret, now), null)
  assert.equal(deviceGatewayTicketValid(`live:${channel}`, proof.token, secret, now), false)
  assert.equal(readDevicePresenceGrant(deviceGatewayTicket(`live:${channel}`, secret, now).protocol, channel, secret, now), null)
})

test('bounded grants reject duplicates, extra content and oversized device lists instead of claiming coverage', () => {
  const many = Array.from({ length: PRESENCE_MAX_DEVICES }, (_, n): PresenceDevice => [`20000000-0000-4000-8000-${n.toString().padStart(12, '0')}`, true, now + 60_000])
  const proof = devicePresenceGrant(scope, many, secret, now)!
  assert.ok(proof)
  assert.ok(JSON.stringify({ type: 'presence_watch', id: 'x'.repeat(64), token: proof.token }).length <= 2048)
  assert.equal(devicePresenceGrant(scope, [...many, devices[0]], secret, now), null)
  assert.equal(devicePresenceGrant(scope, [devices[0], devices[0]], secret, now), null)
  assert.equal(devicePresenceGrant(scope, [], secret, now), null)
  const payload = Buffer.from(JSON.stringify({ channel, home: scope.workspaceId, expiresAt: now + PRESENCE_GRANT_MS, devices, prompt: 'not accepted' })).toString('base64url')
  const mac = createHmac('sha256', secret).update(`mikka-presence-v1.${payload}`).digest('hex')
  assert.equal(readDevicePresenceGrant(`${payload}.${mac}`, channel, secret, now), null)
})

test('only explicitly negotiated, closed control messages can change presence coverage', () => {
  const token = devicePresenceGrant(scope, devices, secret, now)!.token
  assert.deepEqual(presenceCommand({ type: 'presence_watch', id: 'p1', token }), { type: 'presence_watch', id: 'p1', token })
  assert.deepEqual(presenceCommand({ type: 'presence_unwatch', id: 'p1' }), { type: 'presence_unwatch', id: 'p1' })
  for (const invalid of [{ type: 'presence_watch', id: 'p1', token, prompt: 'x' }, { type: 'presence_watch', id: '../wrong', token }, { type: 'presence_watch', id: 'p1', token: 'x'.repeat(2048) }]) assert.equal(presenceCommand(invalid), null)
  assert.deepEqual(presenceReply({ type: 'presence_ready', version: 1 }), { type: 'presence_ready', version: 1 })
  assert.equal(presenceReply({ type: 'presence_ready', version: 2 }), null)
  assert.equal(presenceReply({ type: 'presence_ack', id: 'p1', expiresAt: 'future' }), null)
  assert.equal(presenceReply({ type: 'presence_ack', id: 'p1', expiresAt: now, devices }), null)
})
