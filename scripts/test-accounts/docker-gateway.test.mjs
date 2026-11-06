import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import test from 'node:test'
import { assertDockerBuild, closeDockerResources } from '../../apps/desktop/test/docker-environment.mjs'
import { dockerGatewayRequest, proxyDockerGateway, proxyDockerGatewayUpgrade } from './docker-gateway.mjs'

const channel = 'a'.repeat(64)
const device = '00000000-0000-4000-8000-000000000001'

async function listen(server, t) {
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

test('the public gateway exposes only existing exact Worker routes and operations', () => {
  for (const path of [`/v1/live/${channel}/socket`, `/v1/devices/${device}/socket`]) {
    assert.equal(dockerGatewayRequest(path, 'GET', true), true)
    assert.equal(dockerGatewayRequest(path, 'GET'), true)
    assert.equal(dockerGatewayRequest(path, 'POST', true), false)
    assert.equal(dockerGatewayRequest(path, 'HEAD'), false)
  }
  for (const path of [`/v1/live/${channel}/push`, `/v1/devices/${device}/push`]) {
    assert.equal(dockerGatewayRequest(path, 'POST'), true)
    assert.equal(dockerGatewayRequest(path, 'GET'), false)
    assert.equal(dockerGatewayRequest(path, 'GET', true), false)
  }
  assert.equal(dockerGatewayRequest(`/v1/devices/${device}/status`, 'GET'), true)
  for (const path of [`/v1/live/${channel}/status`, `/v1/live/${channel}/socket?ticket=x`, `/v1/live/${channel}/socket/extra`, '/mikka/api/auth/get-session', '/v1/devices/foreign/socket', '//foreign.invalid/path']) {
    for (const method of ['GET', 'POST', 'DELETE']) assert.equal(dockerGatewayRequest(path, method), false)
  }
})

test('the live socket accepts only the exact revision query used by the native client', () => {
  const target = new URL(`/v1/live/${channel}/socket`, 'wss://gateway.example.invalid')
  target.searchParams.set('revisions', '1')
  const path = target.pathname + target.search
  assert.equal(dockerGatewayRequest(path, 'GET', true), true)
  assert.equal(dockerGatewayRequest(path, 'GET'), true)
  for (const query of ['?', '?revisions=0', '?revisions=01', '?revisions=%31', '?%72evisions=1', '?Revisions=1', '?revisions=1&', '?revisions=1&revisions=1', '?revisions=1&ticket=x', '?ticket=x&revisions=1', '?revisions=1#fragment']) {
    assert.equal(dockerGatewayRequest(`/v1/live/${channel}/socket${query}`, 'GET', true), false)
  }
  for (const path of [`/v1/live/${channel}/push`, `/v1/devices/${device}/socket`, `/v1/devices/${device}/push`, `/v1/devices/${device}/status`]) {
    for (const method of ['GET', 'POST']) assert.equal(dockerGatewayRequest(`${path}?revisions=1`, method), false)
    assert.equal(dockerGatewayRequest(`${path}?revisions=1`, 'GET', true), false)
  }
})

test('the HTTP proxy preserves Worker authentication/status and streams only to fixed loopback', async t => {
  let received
  const worker = createServer((req, res) => {
    received = { path: req.url, method: req.method, authorization: req.headers.authorization, forwarded: req.headers['x-forwarded-host'], metadata: Object.keys(req.headers).filter(key => key.startsWith('mf-')) }
    res.writeHead(req.headers.authorization === 'Bearer synthetic-worker-secret' ? 204 : 401)
    res.end()
  })
  const gateway = await listen(worker, t)
  const publicServer = createServer((req, res) => proxyDockerGateway(req, res, gateway))
  const publicUrl = await listen(publicServer, t)
  const path = `/v1/live/${channel}/push`
  assert.equal((await fetch(publicUrl + path, { method: 'POST', headers: { authorization: 'Bearer synthetic-worker-secret', 'x-forwarded-host': 'untrusted.invalid', 'MF-Original-URL': 'http://private.invalid/foreign', 'mF-Route-Override': 'foreign-worker', 'MF-CF-Blob': '{}', 'MF-Unknown-Metadata': 'synthetic' }, body: '[]' })).status, 204)
  assert.deepEqual(received, { path, method: 'POST', authorization: 'Bearer synthetic-worker-secret', forwarded: undefined, metadata: [] })
  assert.equal((await fetch(publicUrl + path, { method: 'POST', body: '[]' })).status, 401)
  for (const forbidden of ['https://127.0.0.1:3000', 'http://localhost:3000', 'http://foreign.invalid:3000', `${gateway}/foreign`, `${gateway}?target=foreign`]) {
    assert.throws(() => proxyDockerGateway({ url: path, method: 'POST', headers: {} }, {}, forbidden), { code: 'DOCKER_GATEWAY_TARGET_FORBIDDEN' })
  }
})

test('WebSocket upgrades retain the capability protocol, rejection and duplex bytes', async t => {
  const protocol = 'mikka-ticket-synthetic-owned-capability'
  let received
  const worker = createServer()
  worker.on('upgrade', (req, socket, head) => {
    received = { path: req.url, metadata: Object.keys(req.headers).filter(key => key.startsWith('mf-')) }
    if (req.headers['sec-websocket-protocol'] !== protocol) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`)
    if (head.length) socket.write(head)
    socket.pipe(socket)
  })
  const gateway = await listen(worker, t)
  const publicServer = createServer()
  publicServer.on('upgrade', (req, socket, head) => proxyDockerGatewayUpgrade(req, socket, head, gateway))
  const publicUrl = await listen(publicServer, t)
  const target = new URL(`/v1/live/${channel}/socket`, publicUrl)
  target.searchParams.set('revisions', '1')
  const rejected = request(target, { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-protocol': 'foreign-capability' } })
  rejected.end()
  const [denied] = await once(rejected, 'response')
  assert.equal(denied.statusCode, 401)
  denied.resume()
  const allowed = request(target, { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-protocol': protocol, 'MF-Original-URL': 'http://private.invalid/foreign', 'mF-Route-Override': 'foreign-worker', 'MF-Proxy-Shared-Secret': 'synthetic-client-metadata' } })
  allowed.end()
  const [response, socket] = await once(allowed, 'upgrade')
  assert.equal(response.statusCode, 101)
  assert.equal(response.headers['sec-websocket-protocol'], protocol)
  assert.deepEqual(received, { path: `/v1/live/${channel}/socket?revisions=1`, metadata: [] })
  socket.write('duplex-acceptance')
  const [echo] = await once(socket, 'data')
  assert.equal(echo.toString('utf8'), 'duplex-acceptance')
  socket.destroy()
})

test('the public runtime refuses another environment, SHA, base path or broad proxy trust', () => {
  const revision = 'a'.repeat(40)
  const environment = { kind: 'isolated-docker', deploymentSha: revision, basePath: '/mikka' }
  const built = { version: 1, preset: 'node-server', basePath: '/mikka', revision, testDeploymentSha: revision,
    docker: { entry: 'server/mikka-docker.mjs', application: 'server/docker-entry.mjs', trustProxy: false } }
  assert.doesNotThrow(() => assertDockerBuild(environment, revision, built))
  assert.throws(() => assertDockerBuild({ ...environment, kind: 'isolated-ci' }, revision, built), { code: 'DOCKER_RUNTIME_DESCRIPTOR_REQUIRED' })
  assert.throws(() => assertDockerBuild(environment, 'b'.repeat(40), built), { code: 'DOCKER_RUNTIME_COMPILED_REVISION_MISMATCH' })
  assert.throws(() => assertDockerBuild(environment, revision, { ...built, testDeploymentSha: 'b'.repeat(40) }), { code: 'DOCKER_RUNTIME_COMPILED_REVISION_MISMATCH' })
  for (const change of [{ version: 2 }, { preset: 'vercel' }, { basePath: '/' }, { docker: { ...built.docker, trustProxy: true } },
    { docker: { ...built.docker, entry: 'server/index.mjs' } }, { docker: { ...built.docker, application: 'server/unknown.mjs' } }]) {
    assert.throws(() => assertDockerBuild(environment, revision, { ...built, ...change }), { code: 'DOCKER_RUNTIME_CONFIG_MISMATCH' })
  }
})

test('public cleanup waits for real HTTP, Workflow and Worker completion in ownership order', async () => {
  const order = [], appClosed = Promise.withResolvers(), workerClosed = Promise.withResolvers()
  let done = false
  const cleaning = closeDockerResources({
    server: { listening: true, closeAllConnections: () => order.push('connections'), close: callback => { order.push('server'); callback() } },
    sockets: new Set([{ destroy: () => order.push('socket') }]),
    app: { close: () => { order.push('app'); return appClosed.promise } },
    worker: { close: () => { order.push('worker'); return workerClosed.promise } },
  }).then(() => { done = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['connections', 'socket', 'server', 'app']); assert.equal(done, false)
  appClosed.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['connections', 'socket', 'server', 'app', 'worker']); assert.equal(done, false)
  workerClosed.resolve(); await cleaning
  assert.equal(done, true)
})

test('a timed-out Workflow close still disposes the Worker and preserves the original failure', async () => {
  const original = new Error('original failure retained in memory')
  let workerClosed = false
  await assert.rejects(closeDockerResources({ sockets: new Set(), app: { close: () => new Promise(() => {}) },
    worker: { close: () => { workerClosed = true } } }, { closeMs: 5, originalFailure: original }), error => {
    assert.equal(error.message, 'DOCKER_RUNTIME_CLOSE_FAILED')
    assert.equal(error.errors[0], original)
    assert.equal(error.errors[1].message, 'DOCKER_RUNTIME_APP_CLOSE_TIMEOUT')
    return true
  })
  assert.equal(workerClosed, true)
})
