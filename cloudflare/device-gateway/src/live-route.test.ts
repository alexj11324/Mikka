import assert from 'node:assert/strict'
import test from 'node:test'
import { liveChannelId, liveTicket } from '../../../lib/live/scope'
import { deviceGatewayTicket } from '../../../lib/device-gateway-ticket'
import type { LiveInvalidation } from '../../../lib/live/events'
import { handleRequest, type GatewayEnv } from './route'

const secret = 'local-live-route-secret'
const workspace = '19df8afd-0f8c-4c6b-bc9c-20df0b046a72'
const scope = { ownerId: 'owner', workspaceId: workspace }
const channel = liveChannelId(scope)
function gateway() {
  const names: string[] = [], pushed: LiveInvalidation[][] = [], protocols: string[] = [], revoked: string[] = []
  const env: GatewayEnv = { GATEWAY_PUSH_SECRET: secret, DEVICE_SESSION: { getByName(name) {
    names.push(name)
    return { notify: async () => {}, notifyLive: async events => { pushed.push(events) }, revokeLive: async () => { revoked.push(name) }, status: async () => ({ online: false, lastSeenAt: null }), fetch: async request => { protocols.push(request.headers.get('sec-websocket-protocol')!); return new Response(null) },
      watchPresence: async () => ({ accepted: true, changed: false }), unwatchPresence: async () => {}, presenceChanged: async () => [] }
  } } }
  return { names, pushed, protocols, revoked, env }
}

test('a browser upgrade can reach only its signed owner/workspace object', async () => {
  const g = gateway()
  const ticket = liveTicket(scope, { url: 'https://gateway.test', secret })
  for (const protocol of [
    liveTicket({ ...scope, ownerId: 'peer' }, { url: 'https://gateway.test', secret }).protocol,
    liveTicket({ ...scope, workspaceId: 'e4ec7f73-0a59-4ad4-8b3c-41f8cd510c6d' }, { url: 'https://gateway.test', secret }).protocol,
    deviceGatewayTicket(channel, secret).protocol,
  ]) {
    assert.equal((await handleRequest(new Request(`https://gateway.test/v1/live/${channel}/socket`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': protocol } }), g.env)).status, 401)
  }
  assert.deepEqual(g.names, [])
  const accepted = await handleRequest(new Request(`https://gateway.test/v1/live/${channel}/socket`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': `other, ${ticket.protocol}` } }), g.env)
  assert.equal(accepted.status, 200)
  assert.deepEqual(g.names, [`live:${channel}`])
  assert.deepEqual(g.protocols, [ticket.protocol])
})

test('only the authenticated publisher can deliver bounded invalidation keys', async () => {
  const g = gateway(), payload = [{ kind: 'factory_task', id: workspace }]
  const push = (body: unknown, authorization = `Bearer ${secret}`) => handleRequest(new Request(`https://gateway.test/v1/live/${channel}/push`, { method: 'POST', headers: { authorization }, body: JSON.stringify(body) }), g.env)
  assert.equal((await push(payload, '')).status, 401)
  assert.equal((await push([{ ...payload[0], prompt: 'private' }])).status, 400)
  assert.equal((await push([{ ...payload[0], id: 'x'.repeat(3000) }])).status, 400)
  assert.equal((await push([{ ...payload[0], kind: 'unknown' }])).status, 400)
  assert.deepEqual(g.names, [])
  assert.equal((await push(payload)).status, 204)
  assert.deepEqual(g.pushed, [payload])
  const approval = [{ kind: 'approved_writes', id: workspace }, { kind: 'approved_write', id: workspace }]
  assert.equal((await push(approval)).status, 204)
  assert.deepEqual(g.pushed.at(-1), approval)
  const maps = [{ kind: 'project_map', id: workspace }]
  assert.equal((await push(maps)).status, 204)
  assert.deepEqual(g.pushed.at(-1), maps)
  const revised = [{ kind: 'bot_chat', id: workspace, rev: 3 }]
  assert.equal((await push(revised)).status, 204)
  assert.deepEqual(g.pushed.at(-1), revised)
  assert.equal((await push([{ ...revised[0], rev: 'three' }])).status, 400)
})

test('the existing push endpoint accepts only an authenticated closed revocation control and returns an explicit ACK', async () => {
  const g = gateway()
  const push = (body: unknown, authorization = `Bearer ${secret}`) => handleRequest(new Request(`https://gateway.test/v1/live/${channel}/push`, {
    method: 'POST', headers: { authorization }, body: JSON.stringify(body),
  }), g.env)
  assert.equal((await push({ type: 'live_revoked' }, '')).status, 401)
  for (const body of [{ type: 'live_revoked', sessionId: 'not-a-wire-field' }, { type: 'session_revoked' }, [{ type: 'live_revoked' }]]) {
    assert.equal((await push(body)).status, 400)
  }
  assert.deepEqual(g.names, [])
  const accepted = await push({ type: 'live_revoked' })
  assert.equal(accepted.status, 200)
  assert.deepEqual(await accepted.json(), { revoked: true })
  assert.deepEqual(g.revoked, [`live:${channel}`])
  assert.deepEqual(g.pushed, [])
})
