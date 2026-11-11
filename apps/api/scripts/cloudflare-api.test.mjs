import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { verifyBusinessWorld, verifyConfiguration, verifyImage } from '../../../cloudflare/api/start.mjs'

const build = 'a'.repeat(40), overlay = 'b'.repeat(40), id = 'aaaaaaaaaaaa-1949-1'
const env = {
  NODE_ENV: 'production', MIKKA_EDITION: 'cloud', MIKKA_DEPLOYMENT_STAGE: 'production',
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
  for (const stage of [undefined, 'preview', 'development']) {
    assert.throws(() => verifyConfiguration({ ...env, MIKKA_DEPLOYMENT_STAGE: stage }), /DEPLOYMENT_STAGE_INVALID/)
  }
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
  assert.equal(config.vars.MIKKA_DEPLOYMENT_ID, input.release)
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

test('the private API receives its sign-in and product bindings without inheriting deployment or broker authority', async () => {
  const { applicationEnvironment } = await import('../../../cloudflare/api/ingress/environment.mjs')
  const origin = 'https://app.example'
  const allowed = {
    GOOGLE_CLIENT_ID: 'google', GOOGLE_CLIENT_SECRET: 'google-credential',
    GITHUB_CLIENT_ID: 'github', GITHUB_CLIENT_SECRET: 'github-credential',
    BETTER_AUTH_SECRET: 'auth', TURNSTILE_SECRET_KEY: 'signup-verification', MIKKA_CLOUDFLARE_TASK_WORKSPACES: 'sponsor',
    MIKKA_DEPLOYMENT_ID: id, MIKKA_WORKFLOW_QUEUE_PUBLIC_KEY: 'public-verification-key',
    OPENAI_DECISIONS_API_KEY: 'decisions', CLOUDFLARE_WORKERS_AI_TOKEN: 'models',
  }
  const unexpected = {
    GITHUB_APP_PRIVATE_KEY: 'app-signing', AWS_ACCESS_KEY_ID: 'aws', AWS_SECRET_ACCESS_KEY: 'aws-secret',
    CREDENTIAL_BROKER_ROLE_ARN: 'broker', EVE_QUEUE_SIGNING_KEY: 'world-signing',
    INFISICAL_CLIENT_SECRET: 'deploy', CLOUDFLARE_API_TOKEN: 'deploy', VERCEL_OIDC_TOKEN: 'legacy',
    NODE_OPTIONS: '--inspect', BETTER_AUTH_URL: 'https://incorrect.example', MIKKA_API_INGRESS: 'other',
    STRIPE_WEBHOOK_SECRET: {}, SMTP_URL: '', TASK_MACHINE: { destroy() {} },
  }
  assert.deepEqual(applicationEnvironment({ PUBLIC_ORIGIN: origin, ...allowed, ...unexpected }), {
    BETTER_AUTH_URL: origin, MIKKA_API_INGRESS: 'cloudflare', ...allowed,
  })
})

test('private World calls require the instance capability and forward only WDK payload and media headers', async () => {
  const { businessWorldRequest } = await import('../../../cloudflare/api/ingress/services.mjs')
  const token = 'instance-token'
  const calls = []
  const binding = { fetch: async req => { calls.push(req); return new Response('receipt') } }
  const options = { method: 'POST', body: 'cbor', headers: {
    'content-type': 'application/cbor', 'x-mikka-world-capability': token,
    authorization: 'internal', cookie: 'session=x', 'x-forwarded-host': 'external.example',
  } }
  const url = 'https://world.internal/world/rpc'
  for (const [target, init, expected] of [
    ['https://other.example/world/rpc', options, 404],
    ['http://world.internal/world/rpc', options, 404],
    ['https://world.internal/unknown', options, 404],
    [url, {}, 404], [url, { ...options, headers: {} }, 403],
  ]) assert.equal((await businessWorldRequest(new Request(target, init), binding, token)).status, expected)
  assert.equal(calls.length, 0)
  const result = await businessWorldRequest(new Request(url, options), binding, token)
  assert.equal(await result.text(), 'receipt')
  assert.deepEqual([...calls[0].headers.keys()], ['content-type'])
  assert.equal(await calls[0].text(), 'cbor')
  assert.equal(calls[0].redirect, 'manual')
})

test('the private Eve API preserves session, signed body, stream cancellation and query while removing hop authority', async () => {
  const { eveServiceRequest } = await import('../../../cloudflare/api/ingress/services.mjs')
  const controller = new AbortController()
  const origin = 'https://eve.internal'
  const product = { 'x-mikka-submission-id': 'submit', 'x-mikka-evaluation-id': 'evaluation',
    'x-mikka-workspace-id': 'workspace', 'x-mikka-locale': 'en', 'x-mikka-bot-id': 'bot' }
  const options = { method: 'POST', body: ' signed bytes ', signal: controller.signal, headers: {
    ...product, authorization: 'Bearer sample', cookie: 'session=fixture', origin: 'https://app.example',
    'x-slack-signature': 'fixture', 'x-forwarded-host': 'other.example', 'x-forwarded-for': '192.0.2.11',
    'x-vercel-id': 'fixture-a', 'x-vercel-region': 'fixture-b', 'x-mikka-world-capability': 'other',
    connection: 'x-hop', 'x-hop': 'drop',
  } }
  let sent
  const stream = new TransformStream()
  const binding = { fetch: async req => { sent = req; return new Response(stream.readable) } }
  for (const url of [origin + '/.well-known/workflow/v1/flow', origin + '/eve/v1/a%2fb',
    'https://other.example/eve/v1/session']) assert.equal((await eveServiceRequest(new Request(url, options), binding)).status, 404)
  const res = await eveServiceRequest(new Request(origin + '/eve/v1/session?botId=sample', options), binding)
  assert.equal(new URL(sent.url).search, '?botId=sample')
  assert.equal(sent.headers.get('authorization'), 'Bearer sample')
  assert.equal(sent.headers.get('x-slack-signature'), 'fixture')
  assert.equal(sent.headers.get('cookie'), 'session=fixture')
  for (const [name, value] of Object.entries(product)) assert.equal(sent.headers.get(name), value)
  for (const name of ['connection', 'x-hop', 'x-forwarded-for', 'x-forwarded-host', 'x-vercel-id', 'x-vercel-region', 'x-mikka-world-capability']) assert.equal(sent.headers.has(name), false)
  assert.equal(await sent.text(), ' signed bytes ')
  const write = stream.writable.getWriter().write(new Uint8Array([42]))
  assert.deepEqual((await res.body.getReader().read()).value, new Uint8Array([42]))
  await write
  controller.abort()
  assert.equal(sent.signal.aborted, true)
})

test('only the named business workflow callback forwards signed bytes to the matching private release', async () => {
  const { businessWorkflowDelivery, publicWorkflowDispatch } = await import('../../../cloudflare/api/ingress/services.mjs')
  const env = { PUBLIC_ORIGIN: 'https://app.example', MIKKA_DEPLOYMENT_ID: id, BUSINESS_WORLD: {} }
  const url = 'https://business-workflow.internal/.well-known/workflow/v1/flow'
  const headers = { 'x-mikka-eve-release': id, 'x-mikka-queue-time': '123',
    'x-mikka-queue-signature': 'signature', 'cf-queue-retry-count': '0', 'content-type': 'application/json',
    cookie: 'unwanted', authorization: 'unwanted', 'x-forwarded-host': 'untrusted.example' }
  const options = { method: 'POST', body: ' {"event":1}\n', headers }
  let calls = 0
  const send = async req => {
    calls++
    assert.equal(req.url, 'https://app.example/.well-known/workflow/v1/flow')
    assert.equal(req.headers.get('x-forwarded-host'), 'app.example')
    assert.equal(req.headers.get('cookie'), null)
    assert.equal(req.headers.get('authorization'), null)
    assert.equal(req.headers.get('x-mikka-queue-signature'), 'signature')
    assert.equal(await req.text(), options.body)
    return new Response('receipt', { headers: { 'x-mikka-eve-release': id } })
  }
  const run = (target, init) => businessWorkflowDelivery(new Request(target, init), env, send)
  assert.equal((await run(url.replace('flow/v1/flow', 'flow/v1/step'), options)).status, 404)
  assert.equal((await run(url, {})).status, 404)
  assert.equal((await run(url, { ...options, headers: { ...headers, 'x-mikka-eve-release': 'old' } })).status, 409)
  assert.equal((await run(url, { ...options, headers: { ...headers, 'x-mikka-queue-signature': '' } })).status, 403)
  assert.equal(calls, 0)
  assert.equal((await run(url, options)).headers.get('x-mikka-eve-release'), id)
  assert.equal(calls, 1)
  assert.equal(publicWorkflowDispatch('https://app.example/mikka/%2ewell-known/workflow/v1/flow'), true)
  assert.equal(publicWorkflowDispatch('https://app.example/.well-known/workflow/v1/step'), true)
  assert.equal(publicWorkflowDispatch('https://app.example/.well-known/openid-configuration'), false)
})

test('the hosted image verifies its bundled WDK business client and requires scoped private bindings', () => {
  const bytes = Buffer.from('qualification module')
  const evidence = { businessWorld: { path: 'world-business.mjs', sha256: createHash('sha256').update(bytes).digest('hex') } }
  verifyBusinessWorld(evidence, bytes)
  assert.throws(() => verifyBusinessWorld({}, bytes), /BUSINESS_WORLD_MISMATCH/)
  assert.throws(() => verifyBusinessWorld(evidence, Buffer.from('different')), /BUSINESS_WORLD_MISMATCH/)
  const bindings = { ...env, MIKKA_API_INGRESS: 'cloudflare', MIKKA_EVE_ORIGIN: 'https://eve.internal',
    MIKKA_DEPLOYMENT_ID: id, WORKFLOW_TARGET_WORLD: '/app/world-business.mjs',
    MIKKA_WORKFLOW_QUEUE_PUBLIC_KEY: Buffer.alloc(32, 2).toString('base64'),
    MIKKA_BUSINESS_WORLD_TOKEN: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'.repeat(2) }
  verifyConfiguration(bindings)
  for (const key of ['MIKKA_DEPLOYMENT_ID','MIKKA_WORKFLOW_QUEUE_PUBLIC_KEY','MIKKA_BUSINESS_WORLD_TOKEN','WORKFLOW_TARGET_WORLD']) {
    assert.throws(() => verifyConfiguration({ ...bindings, [key]: '' }), /PRIVATE_BINDINGS_REQUIRED/)
  }
  assert.throws(() => verifyConfiguration({ ...bindings, MIKKA_EVE_ORIGIN: 'https://other.example' }), /PRIVATE_BINDINGS_REQUIRED/)
})
