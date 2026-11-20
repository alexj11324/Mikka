import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { test } from 'node:test'
import { startFixtureProxy } from './proxy.mjs'

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
async function unusedOrigin() { const server = createServer(); const origin = await listen(server); await close(server); return origin }

test('fixture login uses the normal password HTTP endpoint and only returns its cookie for the exact identity', async t => {
  const origin = await unusedOrigin(), calls = [], credential = { userId: 'fixture-owner', email: 'fixture@mikka.invalid', password: 'ephemeral-test-password', path: '/mikka/zh-CN/?section=all-issues' }
  let wrongIdentity = false
  const upstreamServer = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    calls.push({ url: request.url, host: request.headers.host, body: JSON.parse(Buffer.concat(chunks).toString()) })
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'fixture-session=opaque; Path=/; HttpOnly; SameSite=Lax' })
    response.end(JSON.stringify({ user: { id: wrongIdentity ? 'another-person' : credential.userId } }))
  })
  const upstream = await listen(upstreamServer); t.after(() => close(upstreamServer))
  const proxy = await startFixtureProxy({ origin, upstream, fixtures: new Map([['board', credential]]), defaultScene: 'board' }); t.after(() => proxy.close())
  const response = await fetch(`${origin}/__fixture/board`, { redirect: 'manual' })
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), credential.path)
  assert.match(response.headers.get('set-cookie'), /^fixture-session=opaque;/)
  assert.deepEqual(calls, [{ url: '/mikka/api/auth/sign-in/email', host: new URL(origin).host, body: { email: credential.email, password: credential.password } }])
  wrongIdentity = true
  const refused = await fetch(`${origin}/__fixture/board`, { redirect: 'manual' })
  assert.equal(refused.status, 502)
  assert.equal(refused.headers.has('set-cookie'), false)
  assert.equal(await refused.text(), 'FIXTURE_LOGIN_OR_PROXY_FAILED')
})

test('fixture login rejects cross-site/foreign-host requests, unselected scenes and remote upstreams', async t => {
  const origin = await unusedOrigin()
  const proxy = await startFixtureProxy({ origin, upstream: 'http://127.0.0.1:1', fixtures: new Map(), defaultScene: 'empty' }); t.after(() => proxy.close())
  for (const headers of [{ origin: 'https://example.test' }, { host: 'example.test' }, { 'sec-fetch-site': 'cross-site' }]) {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}/__fixture/board`, { headers }, response => { response.resume(); resolve(response.statusCode) })
      request.once('error', reject); request.end()
    })
    assert.equal(status, 403)
  }
  assert.equal((await fetch(`${origin}/__fixture/unknown`, { redirect: 'manual' })).status, 404)
  await assert.rejects(startFixtureProxy({ origin, upstream: 'https://example.test', fixtures: new Map(), defaultScene: 'empty' }), /FIXTURE_ORIGIN_NOT_LOOPBACK/)
})

test('fixture proxy preserves live upgrade bytes and protocol only for its exact browser origin', async t => {
  const origin = await unusedOrigin(), received = [], peers = new Set()
  const upstreamServer = createServer()
  upstreamServer.on('upgrade', (request, socket) => {
    peers.add(socket); socket.once('close', () => peers.delete(socket)); socket.once('end', () => socket.destroy())
    received.push({ host: request.headers.host, protocol: request.headers['sec-websocket-protocol'], forwarded: request.headers['x-forwarded-host'] })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: synthetic-ticket\r\n\r\n')
    socket.on('data', bytes => socket.write(Buffer.concat([Buffer.from('echo:'), bytes])))
  })
  const upstream = await listen(upstreamServer); t.after(() => { for (const peer of peers) peer.destroy(); return close(upstreamServer) })
  const proxy = await startFixtureProxy({ origin, upstream, fixtures: new Map(), defaultScene: 'empty' }); t.after(() => proxy.close())
  const upgrade = headers => new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/mikka/v1/live/fixture/socket`, { headers: { connection: 'Upgrade', upgrade: 'websocket', origin,
      'sec-websocket-protocol': 'synthetic-ticket', ...headers } })
    request.once('upgrade', (response, socket) => resolve({ response, socket }))
    request.once('response', response => { response.resume(); resolve({ response }) })
    request.once('error', reject); request.end()
  })
  const { response, socket } = await upgrade({ 'x-forwarded-host': 'foreign.invalid' })
  assert.equal(response.statusCode, 101)
  assert.equal(response.headers['sec-websocket-protocol'], 'synthetic-ticket')
  const echoed = new Promise(resolve => socket.once('data', bytes => resolve(bytes.toString())))
  socket.write('live-update'); assert.equal(await echoed, 'echo:live-update')
  socket.destroy()
  assert.deepEqual(received, [{ host: new URL(origin).host, protocol: 'synthetic-ticket', forwarded: undefined }])
  assert.equal((await upgrade({ origin: 'https://foreign.invalid' })).response.statusCode, 403)
  assert.equal(received.length, 1)
})
