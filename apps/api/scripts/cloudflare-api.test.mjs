import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyConfiguration, verifyImage } from '../../../cloudflare/api/start.mjs'

const build = 'a'.repeat(40), overlay = 'b'.repeat(40), id = 'aaaaaaaaaaaa-1949-1'
const env = {
  NODE_ENV: 'production', MIKKA_EDITION: 'cloud',
  BETTER_AUTH_URL: 'https://app.example', MIKKA_EVE_ORIGIN: 'https://eve.example',
  BETTER_AUTH_SECRET: 'test', DATABASE_URL: 'postgres://workspace',
  MIKKA_DATABASE_URL: 'postgres://mikka', WORKFLOW_TARGET_WORLD: '@test/durable-world',
}

test('the hosted API uses the exact official node-server build, overlay and deployment', () => {
  const args = { MIKKA_BUILD_REVISION: build, MIKKA_UI_OVERLAY_SHA: overlay, MIKKA_DEPLOYMENT_ID: id }
  const evidence = { preset: 'node-server', revision: build, overlaySha: overlay, deploymentId: id }
  verifyImage(evidence, args)
  for (const key of Object.keys(evidence)) assert.throws(() => verifyImage({ ...evidence, [key]: 'stale' }, args))
  for (const key of Object.keys(args)) assert.throws(() => verifyImage(evidence, { ...args, [key]: '' }))
})

test('the hosted API needs two trusted service origins, existing PostgreSQL configuration and an external workflow target', () => {
  verifyConfiguration(env)
  for (const key of Object.keys(env)) assert.throws(() => verifyConfiguration({ ...env, [key]: '' }))
  for (const value of [env.BETTER_AUTH_URL, 'https://eve.example/mikka/api/agents', 'http://eve.example', 'https://someone@eve.example', 'https://*.example']) {
    assert.throws(() => verifyConfiguration({ ...env, MIKKA_EVE_ORIGIN: value }), /ORIGINS_INVALID/)
  }
  for (const choice of ['local', 'vercel', '@workflow/world-local', '@workflow/world-vercel']) {
    assert.throws(() => verifyConfiguration({ ...env, WORKFLOW_TARGET_WORLD: choice }), /HOSTED_WORLD_REQUIRED/)
  }
  assert.throws(() => verifyConfiguration({ ...env, VERCEL_ENV: 'production' }), /EDITION_INVALID/)
})

import { apiRequest } from '../../../cloudflare/api/ingress/request.mjs'
import { ingressConfig } from '../../../cloudflare/api/ingress/config.mjs'

test('private ingress keeps authority, body, cookies and upgrades while replacing client proxy fields', async () => {
  const origin = 'https://app.example'
  const request = new Request(origin + '/mikka/api/rpc', { method: 'POST', body: 'payload',
    headers: { authorization: 'Bearer fixture', cookie: 'fixture', 'cf-connecting-ip': '192.0.2.31',
      forwarded: 'for=bad', 'x-forwarded-host': 'other.example', 'x-mikka-edge-ip': '192.0.2.99',
      'cf-container-target-port': '9000', 'x-vercel-ip-city': 'bad', 'x-forwarded-for': '192.0.2.10' } })
  assert.equal(apiRequest(request, 'https://other.example'), null)
  const forwarded = apiRequest(request, origin)
  assert.equal(await forwarded.text(), 'payload')
  for (const [key, value] of Object.entries({ host: 'app.example', authorization: 'Bearer fixture', cookie: 'fixture',
    'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'https', 'x-mikka-edge-ip': '192.0.2.31' })) assert.equal(forwarded.headers.get(key), value)
  for (const key of ['forwarded', 'x-vercel-ip-city', 'x-forwarded-for', 'cf-container-target-port', 'cf-connecting-ip']) assert.equal(forwarded.headers.has(key), false)
  const upgrade = apiRequest(new Request(origin + '/mikka/api/stream', { headers: { upgrade: 'websocket' } }), origin)
  assert.equal(upgrade.headers.get('upgrade'), 'websocket')
  assert.equal(upgrade.headers.get('x-mikka-edge-ip'), null)
})

test('ingress binds only the immutable account image with a private route and a bounded staging pool', () => {
  const input = { release: id, origin: 'https://app.example', image: 'registry.cloudflare.com/' + 'e'.repeat(32) + '/mikka-api@sha256:' + '3'.repeat(64) }
  const config = ingressConfig(input)
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.containers[0].max_instances, 1)
  assert.equal(config.containers[0].image, input.image)
  for (const changed of [{ release: 'main' }, { image: input.image.split('@')[0] + ':latest' }, { origin: 'https://user@app.example' }]) {
    assert.throws(() => ingressConfig({ ...input, ...changed }))
  }
})

import { configureTaskBridge, taskMachine } from '../../../cloudflare/api/ingress/task-machine.mjs'

test('a DO reconnect keeps its own bridge capability and a different DO gets another', async () => {
  const start = async (state) => {
    let configured
    let ready
    const host = { envVars: {}, async setOutboundByHost(...params) { configured = params } }
    configureTaskBridge(host, { storage: { kv: { get: k => state.get(k), put: (k,v) => state.set(k,v) } }, blockConcurrencyWhile(fn) { ready = fn() } })
    await ready
    const token = host.envVars.MIKKA_TASK_MACHINE_BRIDGE_TOKEN
    assert.deepEqual(configured, ['task-machine.internal', 'taskMachine', { token }])
    assert.ok(token.length > 60)
    return token
  }
  const storage = new Map()
  const token = await start(storage)
  assert.equal(await start(storage), token)
  assert.notEqual(await start(new Map()), token)
})

test('task bridge fixes the authority and methods and forwards only a grant and chosen arguments', async () => {
  const seen = []
  const machine = {
    async status(...args) { seen.push(args); return { running: true } },
    async writeFile(...args) { seen.push(args); return { checkpoint: true } },
    async readFile(grant, path) { return path === '/missing' ? null : Uint8Array.of(0, 42, 255) },
    async removePath(...args) { seen.push(args) },
    async park() { throw new Error('Task machine scope mismatch') },
  }
  const token = 'fixture', grant = { ownerId: 'one' }, env = { TASK_MACHINE: machine }, context = { params: { token } }
  const call = (path, data, options = {}) => taskMachine(new Request('http://task-machine.internal' + path, {
    method: 'POST', headers: { authorization: 'Bearer '+token, 'content-type': 'application/json', 'x-untrusted': 'unused' }, body: JSON.stringify(data), ...options
  }), env, context)
  assert.deepEqual(await (await call('/v1/status', { grant })).json(), { running: true })
  assert.deepEqual(await (await call('/v1/write-file', { grant, path: '/bin', base64: 'ACr/' })).json(), { checkpoint: true })
  assert.deepEqual(seen, [[grant], [grant, '/bin', Uint8Array.of(0, 42, 255)]])
  assert.equal((await call('/v1/remove-path', { grant, path:'/f' })).status, 200)
  assert.deepEqual(seen.at(-1), [grant, '/f', { force:false, recursive:false }])
  assert.equal((await call('/v1/remove-path', { grant, path:'/f', recursive:true })).status, 200)
  assert.deepEqual(seen.at(-1), [grant, '/f', { force:false, recursive:true }])
  assert.equal((await call('/v1/remove-path', { grant, path:'/f', force:null })).status, 400)
  assert.deepEqual(new Uint8Array(await (await call('/v1/read-file', { grant, path: '/bin' })).arrayBuffer()), Uint8Array.of(0, 42, 255))
  assert.equal((await call('/v1/read-file', { grant, path:'/missing' })).status, 204)
  assert.equal((await call('/v1/park', { grant })).status, 404)
  assert.equal((await call('/v1/status', { grant }, { headers: {} })).status, 403)
  assert.equal((await call('/v1/status?next=elsewhere', { grant })).status, 404)
  assert.equal((await call('/v1/unchecked', { grant })).status, 404)
  assert.equal((await call('/v1/write-file', { grant, path: '/f', base64: '!' })).status, 400)
  assert.equal((await call('/v1/open', { grant, junk: 'x'.repeat(17*1024) })).status, 413)
  assert.equal((await taskMachine(new Request('https://outside.example/v1/status'), env, context)).status, 404)
  const bound = ingressConfig({release:id,origin:'https://test.example',image:'registry.cloudflare.com/'+'0'.repeat(32)+'/mikka-api@sha256:'+'2'.repeat(64),taskMachine:'dedicated-machines'})
  assert.deepEqual(bound.services, [{ binding:'TASK_MACHINE', service:'dedicated-machines' }])
})

test('the task process handshake requires the private host capability, binding and an exact WebSocket upgrade', async () => {
  const token = 'per-shared-host', url = 'http://task-machine.internal/v1/process'
  const context = { params: { token } }, env = { TASK_MACHINE: {} }
  const headers = { authorization: 'Bearer ' + token, upgrade: 'websocket' }
  const send = (target, options, bindings = env) => taskMachine(new Request(target, options), bindings, context)
  assert.equal((await send(url, { headers: { upgrade: 'websocket' } })).status, 403)
  assert.equal((await send(url, { headers: { ...headers, authorization: 'Bearer other' } })).status, 403)
  assert.equal((await send(url, { headers: { authorization: headers.authorization } })).status, 400)
  assert.equal((await send(url, { method: 'POST', headers })).status, 400)
  assert.equal((await send(url + '?run=x', { headers })).status, 404)
  assert.equal((await send(url.replace('task-machine.internal', 'another.internal'), { headers })).status, 404)
  assert.equal((await send(url, { headers }, {})).status, 503)
})
