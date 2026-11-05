import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

// Use the same workerd runtime as the installed Wrangler. Resolve through its
// real path so pnpm's transitive dependency layout works without a second copy.
const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(realpathSync(require.resolve('wrangler/package.json')))
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = wranglerRequire('miniflare')
const WireWebSocket = wranglerRequire('ws')
const secret = 'local-gateway-integration-test-secret'
const deviceId = '6f1c2b8e-2a8e-4c39-9d1a-3b5d7c9e1f20'
const sockets = new Set()
let runtime
let origin

function ticket(id = deviceId, exp = Math.floor(Date.now() / 1000) + 300) {
  const mac = createHmac('sha256', secret).update(`${id}.${exp}`).digest('hex')
  return `mikka-ticket-${exp}-${mac}`
}

export function event(socket, name, label = name) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for WebSocket ${label}; state=${socket.readyState}`)), 5_000)
    const success = value => finish(null, value)
    const failure = () => finish(new Error(`WebSocket failed before ${name}`))
    function finish(error, value) {
      clearTimeout(timeout)
      socket.removeEventListener(name, success)
      socket.removeEventListener('error', failure)
      if (error) reject(error)
      else resolve(value)
    }
    socket.addEventListener(name, success, { once: true })
    if (name !== 'error') socket.addEventListener('error', failure, { once: true })
  })
}

export function connect(protocol = ticket(), id = deviceId) {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/devices/${id}/socket`, protocol)
  sockets.add(socket)
  return socket
}

export async function status(id = deviceId) {
  const response = await fetch(`${origin}/v1/devices/${id}/status`, {
    headers: { authorization: `Bearer ${secret}` },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return response.json()
}

before(async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    external: ['cloudflare:workers', 'node:crypto'],
    write: false,
  })
  const options = {
    workers: [{
      name: 'gateway-test',
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-10-22',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: { DEVICE_SESSION: { className: 'DeviceSession', useSQLite: true } },
      bindings: { GATEWAY_PUSH_SECRET: secret },
    }],
    host: '127.0.0.1',
    port: 0,
    cf: false,
    log: new Log(LogLevel.WARN),
  }
  runtime = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options)
  origin = (await runtime.ready).origin
})

after(async () => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'test complete')
  }
  await runtime?.dispose()
})

test('Node built-in WebSocket opens against the Worker with its exact ticket protocol', async () => {
  const protocol = ticket()
  const socket = connect(protocol)
  await event(socket, 'open')
  assert.equal(socket.protocol, protocol)
  const presence = await status()
  assert.equal(presence.online, true)
  assert.ok(Number.isFinite(Date.parse(presence.lastSeenAt)))
  const closed = event(socket, 'close')
  socket.close(1000, 'done')
  await closed
  assert.deepEqual(await status(), { online: false, lastSeenAt: null })
})

test('real auto-pongs refresh presence and authenticated pushes reach the same socket', async () => {
  const socket = connect()
  await event(socket, 'open')
  const connected = await status()
  await delay(20)
  const pong = event(socket, 'message')
  socket.send('ping')
  assert.equal((await pong).data, 'pong')
  const pinged = await status()
  assert.equal(pinged.online, true)
  assert.ok(Date.parse(pinged.lastSeenAt) > Date.parse(connected.lastSeenAt), 'the auto-response timestamp must advance presence')

  const work = event(socket, 'message')
  const response = await fetch(`${origin}/v1/devices/${deviceId}/push`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
  })
  assert.equal(response.status, 204)
  assert.equal((await work).data, 'work')
  const closed = event(socket, 'close')
  socket.close(1000, 'done')
  await closed
})

test('a real upgrade selects the validated ticket from multiple offered protocols', async () => {
  const protocol = ticket()
  const socket = connect(['unrelated-protocol', protocol])
  await event(socket, 'open')
  assert.equal(socket.protocol, protocol)
  assert.equal((await status()).online, true)
  const closed = event(socket, 'close')
  socket.close(1000, 'done')
  await closed
})

test('a client close without a status code completes without an invalid-code exception', async () => {
  const socket = connect()
  await event(socket, 'open')
  const closed = event(socket, 'close')
  socket.close()
  const result = await closed
  assert.equal(result.wasClean, true)
  assert.equal(result.code, 1005)
  assert.deepEqual(await status(), { online: false, lastSeenAt: null })
})

test('status rejects a device ticket and wrong server secret, while an absent device is offline', async () => {
  for (const authorization of ['', `Bearer ${ticket()}`, 'Bearer wrong-secret']) {
    const response = await fetch(`${origin}/v1/devices/${deviceId}/status`, { headers: { authorization } })
    assert.equal(response.status, 401)
  }
  const absentDevice = '769840bb-21d8-4949-995b-873aeedcc464'
  assert.deepEqual(await status(absentDevice), { online: false, lastSeenAt: null })
})

test('a real socket upgrade refuses a ticket for another device', async () => {
  const socket = connect(ticket('769840bb-21d8-4949-995b-873aeedcc464'))
  let opened = false
  socket.addEventListener('open', () => { opened = true })
  await event(socket, 'error')
  assert.equal(opened, false)
})

function liveChannel(owner, workspace) {
  return createHash('sha256').update(JSON.stringify([owner, workspace])).digest('hex')
}

function liveSocket(channel, exp, Client = WebSocket) {
  const socket = new Client(`${origin.replace('http:', 'ws:')}/v1/live/${channel}/socket`, ticket(`live:${channel}`, exp))
  sockets.add(socket)
  socket.liveReady = event(socket, 'message').then(message => {
    const value = JSON.parse(message.data)
    assert.equal(value.type, 'live_ready'); assert.equal(value.version, 1)
    assert.ok(value.kinds.includes('approved_writes') && value.kinds.includes('approved_write'))
    return value
  })
  return socket
}

async function pushLive(channel, events) {
  const response = await fetch(`${origin}/v1/live/${channel}/push`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(events),
  })
  assert.equal(response.status, 204)
}

// The installed Miniflare TCP upgrade proxy exchanges Close frames but can
// leave the TCP read side open. Observe the actual RFC Close frame, rather than
// waiting for its FIN. ws is the existing pinned runtime's wire decoder; ordinary
// upgrade, ping and multicast tests above still use Node's built-in WebSocket.
function closeFrame(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No server Close frame')), 5_000)
    socket._receiver.once('conclude', (code, reason) => { clearTimeout(timeout); resolve({ code, reason: reason.toString() }) })
  })
}

test('real browser tabs multicast within one owner/workspace and isolate peers and other workspaces', async () => {
  const channel = liveChannel('owner', 'workspace-one')
  const otherWorkspace = liveChannel('owner', 'workspace-two')
  const otherOwner = liveChannel('peer', 'workspace-one')
  const first = liveSocket(channel), second = liveSocket(channel)
  const elsewhere = liveSocket(otherWorkspace), peer = liveSocket(otherOwner)
  await Promise.all([first, second, elsewhere, peer].map(socket => event(socket, 'open')))
  await Promise.all([first, second, elsewhere, peer].map(socket => socket.liveReady))
  const elsewhereEvents = [], peerEvents = []
  elsewhere.addEventListener('message', message => elsewhereEvents.push(JSON.parse(message.data)))
  peer.addEventListener('message', message => peerEvents.push(JSON.parse(message.data)))
  for (const kind of ['factory_task', 'approved_writes', 'approved_write']) {
    const invalidation = { kind, id: deviceId }
    const received = [event(first, 'message'), event(second, 'message')]
    await pushLive(channel, [invalidation])
    assert.deepEqual((await Promise.all(received)).map(message => JSON.parse(message.data)), [invalidation, invalidation])
  }
  assert.equal(first.readyState, WebSocket.OPEN)
  const marker = { kind: 'thread', id: '769840bb-21d8-4949-995b-873aeedcc464' }
  const markers = [event(elsewhere, 'message'), event(peer, 'message')]
  await pushLive(otherWorkspace, [marker]); await pushLive(otherOwner, [marker])
  await Promise.all(markers)
  assert.deepEqual(elsewhereEvents, [marker])
  assert.deepEqual(peerEvents, [marker])
  for (const socket of [first, second, elsewhere, peer]) socket.close(1000, 'done')
})

test('an expired browser ticket cannot receive later invalidations on an existing socket', async () => {
  const channel = liveChannel('expiry-owner', 'workspace-one')
  const exp = Math.ceil(Date.now() / 1000) + 1
  const socket = liveSocket(channel, exp, WireWebSocket)
  try {
    await event(socket, 'open'); await socket.liveReady
    const messages = []
    socket.addEventListener('message', message => messages.push(message.data))
    await delay(Math.max(0, exp * 1000 - Date.now()) + 20)
    const closed = closeFrame(socket)
    await pushLive(channel, [{ kind: 'factory_task', id: deviceId }])
    assert.equal((await closed).code, 4001)
    assert.deepEqual(messages, [])
  } finally { socket.terminate() }
})

test('daemon reconnects retain their one-socket replacement and work signal', async () => {
  const first = new WireWebSocket(`${origin.replace('http:', 'ws:')}/v1/devices/${deviceId}/socket`, ticket())
  try {
    await event(first, 'open')
    const oldMessages = []
    first.addEventListener('message', message => oldMessages.push(message.data))
    const replaced = closeFrame(first)
    const second = connect(); await event(second, 'open')
    assert.equal((await replaced).code, 4000)
    const work = event(second, 'message')
    await fetch(`${origin}/v1/devices/${deviceId}/push`, { method: 'POST', headers: { authorization: `Bearer ${secret}` } })
    assert.equal((await work).data, 'work')
    assert.deepEqual(oldMessages, [])
    second.close(1000, 'done')
  } finally { first.terminate() }
})

test('Coordinator session invalidation uses the same scoped wire without reply contents', async () => {
  const channel = liveChannel('mcp-owner', 'personal-workspace')
  const socket = liveSocket(channel)
  await event(socket, 'open')
  assert.ok((await socket.liveReady).kinds.includes('coordinator_session'))
  const received = event(socket, 'message')
  const invalidation = { kind: 'coordinator_session', id: deviceId }
  await pushLive(channel, [invalidation])
  assert.deepEqual(JSON.parse((await received).data), invalidation)
  socket.close(1000, 'done')
})
