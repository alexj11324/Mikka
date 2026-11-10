import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
let runtimeOptions
const persistence = mkdtempSync(join(tmpdir(), 'mikka-gateway-revocation-'))

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
  runtimeOptions = convertV4MiniflareOptions
    ? { ...convertV4MiniflareOptions(options), resourcePersistencePath: persistence }
    : { ...options, durableObjectsPersist: persistence }
  runtime = new Miniflare(runtimeOptions)
  origin = (await runtime.ready).origin
})

after(async () => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'test complete')
  }
  await runtime?.dispose()
  rmSync(persistence, { recursive: true, force: true })
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

function liveSocket(channel, exp, Client = WebSocket, version = 1, presence = false) {
  const query = new URLSearchParams({ ...(version === 2 ? { revisions: '1' } : {}), ...(presence ? { presence: '1' } : {}) })
  const socket = new Client(`${origin.replace('http:', 'ws:')}/v1/live/${channel}/socket${query.size ? `?${query}` : ''}`, ticket(`live:${channel}`, exp))
  sockets.add(socket)
  socket.liveReady = event(socket, 'message').then(message => {
    const value = JSON.parse(message.data)
    assert.equal(value.type, 'live_ready'); assert.equal(value.version, version)
    assert.equal(Object.keys(value).length, version === 2 ? 4 : 3, 'a version 1 reader accepts exactly three fields')
    assert.ok(value.kinds.includes('approved_writes') && value.kinds.includes('approved_write'))
    return value
  })
  if (presence) socket.presenceReady = messages(socket, 1, value => value.type === 'presence_ready')
  return socket
}

function messages(socket, count, accept = () => true, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const received = []
    const timeout = setTimeout(() => { socket.removeEventListener('message', read); reject(Error('Timed out waiting for presence frames')) }, timeoutMs)
    const read = event => {
      const value = JSON.parse(event.data)
      if (!accept(value)) return
      received.push(value)
      if (received.length === count) { clearTimeout(timeout); socket.removeEventListener('message', read); resolve(received) }
    }
    socket.addEventListener('message', read)
  })
}

function presenceProof(channel, home, devices, expiresAt = Date.now() + 300_000) {
  const payload = Buffer.from(JSON.stringify({ channel, home, expiresAt, devices })).toString('base64url')
  const mac = createHmac('sha256', secret).update(`mikka-presence-v1.${payload}`).digest('hex')
  return `${payload}.${mac}`
}

test('a real watched device disconnect and reconnect push its owner home without an HTTP heartbeat', async () => {
  const home = 'b1c9a026-f051-4846-b9ae-0bb0866b7124', id = '66884944-5216-40a3-b050-ae4af2920d7e'
  const channel = liveChannel('presence-owner', home)
  const live = liveSocket(channel, undefined, WebSocket, 2, true)
  await event(live, 'open'); await live.liveReady; await live.presenceReady
  const device = connect(ticket(id), id); await event(device, 'open')
  const ack = messages(live, 1, value => value.type === 'presence_ack')
  live.send(JSON.stringify({ type: 'presence_watch', id: 'watched', token: presenceProof(channel, home, [[id, true, 0]]) }))
  await ack
  const expected = [{ kind: 'device_list', id: home }, { kind: 'thread_list', id: home }]
  const offline = messages(live, 2, value => !!value.kind)
  const closed = event(device, 'close'); device.close(1000, 'offline'); await closed
  assert.deepEqual(await offline, expected)
  const online = messages(live, 2, value => !!value.kind)
  const returned = connect(ticket(id), id); await event(returned, 'open')
  assert.deepEqual(await online, expected)
  live.send(JSON.stringify({ type: 'presence_unwatch', id: 'watched' }))
  live.close(1000, 'complete'); returned.close(1000, 'complete')
})

test('a real observer receives natural 90s expiry while the idle device socket remains open', { timeout: 105_000 }, async () => {
  const home = 'bf156f6b-40e7-49e7-8dbb-0dc236e46e1e', id = '2a7d7301-402a-4b18-83f5-10001923571c'
  const channel = liveChannel('expiry-owner', home)
  const live = liveSocket(channel, undefined, WebSocket, 2, true)
  await event(live, 'open'); await live.liveReady; await live.presenceReady
  const device = connect(ticket(id), id); await event(device, 'open')
  const connected = await status(id)
  const ack = messages(live, 1, value => value.type === 'presence_ack')
  live.send(JSON.stringify({ type: 'presence_watch', id: 'expiry', token: presenceProof(channel, home, [[id, true, 0]]) }))
  await ack
  const received = await messages(live, 2, value => !!value.kind, 100_000)
  assert.ok(Date.now() - Date.parse(connected.lastSeenAt) >= 90_000)
  assert.deepEqual(received, [{ kind: 'device_list', id: home }, { kind: 'thread_list', id: home }])
  assert.equal(device.readyState, WebSocket.OPEN)
  assert.equal((await status(id)).online, false)
  live.close(1000, 'complete'); device.close(1000, 'complete')
})

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

test('a version 1 tab gets the plain key while a version 2 tab on the same channel gets its revision', async () => {
  const channel = liveChannel('revision-owner', 'workspace-one')
  const older = liveSocket(channel), newer = liveSocket(channel, undefined, WebSocket, 2)
  await Promise.all([older, newer].map(socket => event(socket, 'open')))
  assert.ok((await newer.liveReady).revisions.includes('bot_chat'))
  await older.liveReady
  const key = { kind: 'bot_chat', id: deviceId }
  const received = [event(older, 'message'), event(newer, 'message')]
  await pushLive(channel, [{ ...key, rev: 41 }])
  assert.deepEqual((await Promise.all(received)).map(message => JSON.parse(message.data)), [key, { ...key, rev: 41 }])
  // A key without a revision reaches both unchanged; a revision on a kind without one is refused.
  const plain = [event(older, 'message'), event(newer, 'message')]
  await pushLive(channel, [key])
  assert.deepEqual((await Promise.all(plain)).map(message => JSON.parse(message.data)), [key, key])
  const refused = await fetch(`${origin}/v1/live/${channel}/push`, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify([{ kind: 'factory_task', id: deviceId, rev: 1 }]) })
  assert.equal(refused.status, 400)
  for (const socket of [older, newer]) socket.close(1000, 'done')
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

test('a durable opaque revocation stops metadata, rejects old-ticket replay after Worker restart, and preserves Personal/new-cap channels', async () => {
  const channel = liveChannel('revoked-session-capability', 'enterprise-workspace')
  const personalChannel = liveChannel('same-user', 'personal-home')
  const newChannel = liveChannel('fresh-assured-session-capability', 'enterprise-workspace')
  const exp = Math.floor(Date.now() / 1000) + 300
  const existing = liveSocket(channel, exp, WireWebSocket, 2)
  const personal = liveSocket(personalChannel, exp, WebSocket, 2)
  try {
    await Promise.all([event(existing, 'open'), event(personal, 'open')])
    await Promise.all([existing.liveReady, personal.liveReady])
    const observed = []
    existing.addEventListener('message', value => observed.push(value.data))
    const before = messages(existing, 3)
    await pushLive(channel, [{ kind: 'thread', id: deviceId, rev: 8 }, { kind: 'artifact', id: deviceId }, { kind: 'factory_task', id: deviceId }])
    assert.equal((await before).length, 3)
    const closed = closeFrame(existing)
    const control = await fetch(`${origin}/v1/live/${channel}/push`, {
      method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ type: 'live_revoked' }),
    })
    assert.equal(control.status, 200)
    assert.deepEqual(await control.json(), { revoked: true })
    assert.equal((await closed).code, 4001)
    const count = observed.length
    await pushLive(channel, [{ kind: 'thread', id: deviceId, rev: 9 }, { kind: 'artifact', id: deviceId }, { kind: 'factory_task', id: deviceId }])
    const personalMessage = event(personal, 'message')
    await pushLive(personalChannel, [{ kind: 'thread', id: deviceId, rev: 10 }])
    assert.deepEqual(JSON.parse((await personalMessage).data), { kind: 'thread', id: deviceId, rev: 10 })
    assert.equal(observed.length, count, 'revoked sockets receive no later UUID or changed revision')
    personal.close(1000, 'restart fixture')
  } finally { existing.terminate() }

  // Use the same persisted DO database in a new workerd process, rather than
  // only proving an in-memory flag. No external Worker is involved.
  await runtime.dispose()
  runtime = new Miniflare(runtimeOptions)
  origin = (await runtime.ready).origin
  const replay = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/live/${channel}/socket`, ticket(`live:${channel}`, exp))
  sockets.add(replay)
  let opened = false
  replay.addEventListener('open', () => { opened = true })
  await event(replay, 'error')
  assert.equal(opened, false, 'an unexpired signed ticket cannot revive the durable tombstone')

  const allowed = liveSocket(newChannel, exp, WebSocket, 2)
  await event(allowed, 'open'); await allowed.liveReady
  const changed = event(allowed, 'message')
  await pushLive(newChannel, [{ kind: 'thread', id: deviceId, rev: 11 }])
  assert.deepEqual(JSON.parse((await changed).data), { kind: 'thread', id: deviceId, rev: 11 })
  allowed.close(1000, 'done')
})
