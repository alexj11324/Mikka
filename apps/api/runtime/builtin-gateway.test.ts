import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { H3 } from 'h3'
import { createGatewayHandler } from '../routes/builtin-gateway'
import { applySecurityHeaders } from './http-policy.mjs'
import { GatewayHub, type GatewayBus } from '../../../lib/builtin-gateway/hub'
import { builtinGatewayConfig } from '../../../lib/builtin-gateway/config'
import { liveChannelId, liveTicket } from '../../../lib/live/scope'

// Use the exact adapter bundled by the installed Nitro preset; no second WS
// dependency or custom production server is introduced for this test.
const require = createRequire(import.meta.url)
const nitroRequire = createRequire(require.resolve('nitro/package.json'))
const { default: adapter } = await import(pathToFileURL(nitroRequire.resolve('crossws/adapters/node')).href)
const { NodeRequest } = await import(pathToFileURL(nitroRequire.resolve('srvx/node')).href)

test('real Nitro Node WebSocket adapter retains authenticated hooks through the HTTP security wrapper', async t => {
  const bus: GatewayBus = { async publish() {}, subscribe() { return () => {} } }
  const hub = new GatewayHub(bus, Date.now, '', async sessionId => sessionId === 'runtime-test-session')
  const server = createServer((_request, response) => { response.writeHead(404); response.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const env = { BETTER_AUTH_URL: `http://127.0.0.1:${port}`, BETTER_AUTH_SECRET: 'local-fixture-auth-secret' }
  const app = new H3().all('/**', createGatewayHandler(() => ({ hub, bus: { async ready() {} } }), env))
  const sockets: WebSocket[] = []
  const websocket = adapter({ resolve: async (request: Request & { [key: symbol]: unknown }) => {
    const response = applySecurityHeaders(request, await app.fetch(request)) as Response & { crossws?: unknown }
    return response.crossws ?? request[Symbol.for('crossws.hooks')] ?? {}
  } })
  server.on('upgrade', (request, socket, head) => {
    websocket.handleUpgrade(request, socket, head, new NodeRequest({ req: request, upgrade: { socket, head } }))
  })
  t.after(async () => {
    for (const socket of sockets) socket.close()
    hub.stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const scope = { ownerId: 'selfhost-owner', workspaceId: 'aab15455-984d-4a05-a5eb-e367214e10b8' }
  const ticket = liveTicket(scope, builtinGatewayConfig(env)!, Date.now(), 'runtime-test-session')
  const socket = new WebSocket(`${ticket.url}?revisions=1`, ['other', ticket.protocol])
  sockets.push(socket)
  const ready = received(socket)
  assert.equal(JSON.parse(await ready).type, 'live_ready')
  assert.equal(socket.protocol, ticket.protocol, 'the server selects only the authenticated offered protocol')
  const invalidated = received(socket)
  await hub.live(liveChannelId(scope), [{ kind: 'thread', id: scope.workspaceId, rev: 2 }])
  assert.deepEqual(JSON.parse(await invalidated), { kind: 'thread', id: scope.workspaceId, rev: 2 })
  const pong = received(socket)
  socket.send('ping')
  assert.equal(await pong, 'pong')
  const refused = new WebSocket(ticket.url, ['mikka-ticket-invalid'])
  sockets.push(refused)
  await new Promise<void>((resolve, reject) => {
    refused.addEventListener('error', () => resolve(), { once: true })
    refused.addEventListener('open', () => reject(new Error('unauthorized upgrade accepted')), { once: true })
  })
})

function received(socket: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket message timed out')), 2000)
    socket.addEventListener('message', event => { clearTimeout(timer); resolve(String(event.data)) }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket failed')) }, { once: true })
  })
}
