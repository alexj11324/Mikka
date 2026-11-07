import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceGatewayTicketValid } from '../device-gateway-ticket'
import { liveInvalidation, liveInvalidations, liveReadiness, liveReady, withoutRevisions } from './events'
import { liveChannelId, liveChannelTicket, liveGatewayConfig, liveTicket } from './scope'
import { readSessionLiveTicket } from './session-ticket'

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

test('a revision is a third field only a version 2 reader accepts, and only a positive integer on a revision kind', () => {
  const plain = { kind: 'bot_chat' as const, id: workspace }
  const revised = { ...plain, rev: 7 }
  // A version 1 reader (an older tab, the mobile app, an older Worker) refuses the extra field.
  assert.equal(liveInvalidation(revised), null)
  assert.deepEqual(liveInvalidation(revised, true), revised)
  assert.deepEqual(liveInvalidation(plain, true), plain)
  for (const invalid of [{ ...plain, rev: 0 }, { ...plain, rev: -1 }, { ...plain, rev: 1.5 }, { ...plain, rev: '7' }, { ...plain, rev: 2 ** 53 },
    { ...plain, revision: 7 }, { kind: 'factory_task', id: workspace, rev: 7 }, { ...revised, extra: 1 }]) assert.equal(liveInvalidation(invalid, true), null)
  assert.deepEqual(withoutRevisions([revised, plain]), [plain, plain])
  assert.deepEqual(liveReadiness(liveReady()), { kinds: liveReady().kinds, revisions: [] })
  assert.deepEqual(liveReadiness(liveReady(2))?.revisions, liveReady(2).revisions)
  assert.equal(liveReadiness({ ...liveReady(), revisions: ['bot_chat'] }), null, 'version 1 has exactly three fields')
  assert.equal(liveReadiness({ type: 'live_ready', version: 2, kinds: ['bot_chat'] }), null)
})

test('gateway configuration uses the existing origin and refuses credential-bearing URLs', () => {
  assert.equal(liveGatewayConfig({ DEVICE_GATEWAY_URL: 'https://gateway.test' }), null)
  assert.equal(liveGatewayConfig({ DEVICE_GATEWAY_URL: 'https://user:password@gateway.test', DEVICE_GATEWAY_PUSH_SECRET: config.secret }), null)
  assert.equal(liveGatewayConfig({ DEVICE_GATEWAY_URL: 'file:///tmp/gateway', DEVICE_GATEWAY_PUSH_SECRET: config.secret }), null)
})

test('opaque capability tickets never outlive the persisted session deadline on either gateway', () => {
  const channel = 'c'.repeat(64), now = 1_800_000_000_000, deadline = now + 35_000
  const worker = liveChannelTicket(channel, config, now, 'actual-session', deadline)
  assert.equal(worker.expiresAt, deadline)
  assert.equal(deviceGatewayTicketValid(`live:${channel}`, worker.protocol, config.secret, deadline - 1), true)
  assert.equal(deviceGatewayTicketValid(`live:${channel}`, worker.protocol, config.secret, deadline), false)
  const builtin = liveChannelTicket(channel, { ...config, mode: 'builtin' }, now, 'actual-session', deadline)
  assert.deepEqual(readSessionLiveTicket(channel, builtin.protocol, config.secret, now), {
    protocol: builtin.protocol, expiresAt: deadline, sessionId: 'actual-session',
  })
})
