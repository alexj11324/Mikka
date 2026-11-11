import assert from 'node:assert/strict'
import { createServer, IncomingMessage, request as sendHttp, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2'
import { once } from 'node:events'
import test from 'node:test'
import { toNodeHandler } from 'srvx/node'
import { build } from 'esbuild'
import type { ServerRequest } from 'srvx'
import { browserRpcOrigin } from '../../../lib/browser-rpc/handler'
import { createApiHandler } from '../src/application'
import { requireRequestScope } from '../src/context'
import { after } from '../compat/server'
import { vercelRequestAuthority } from '../request-authority-module.mjs'
import { withNodeRequestAuthority, withVercelRequestAuthority } from './request-authority'
import authorityPlugin from '../plugins/request-authority'
import securityHeadersPlugin from '../plugins/security-headers'

const require = createRequire(import.meta.url)
const origin = 'https://app.example.test'
const platformHost = 'mikka-revision-team.vercel.app'
type Application = { fetch: (request: ServerRequest) => Response | Promise<Response> }
const configuration = { origin, deploymentHost: platformHost }

/** Compile the installed, unmodified Nitro Vercel Node adapter. Only its
 * generated application slot is a local contract fixture; srvx, IncomingMessage
 * and ServerResponse are real. This is HTTP-boundary evidence, not deployed
 * application/authentication or managed Workflow acceptance. */
async function officialAdapter() {
  const nitro = dirname(require.resolve('nitro/package.json'))
  const source = join(nitro, 'dist/presets/vercel/runtime/vercel.node.mjs')
  const runtimeRequire = createRequire(source)
  const sourceText = await readFile(source, 'utf8')
  assert.match(sourceText, /toNodeHandler\(/)
  const result = await build({
    stdin: { contents: `export { default } from ${JSON.stringify(source)}; export { setApplication } from 'nitro/app'`, resolveDir: nitro },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24',
    define: { 'import.meta._websocket': 'false' }, logLevel: 'silent',
    plugins: [{ name: 'local-application-slot', setup(builder) {
      builder.onResolve({ filter: /^(?:nitro\/app|#nitro\/virtual\/polyfills|#nitro\/runtime\/app)$/ }, args => ({ path: args.path, namespace: 'application-slot' }))
      builder.onLoad({ filter: /.*/, namespace: 'application-slot' }, args => ({ contents: args.path === 'nitro/app'
        ? `let application; const app = { fetch: request => application.fetch(request) }; export const useNitroApp = () => app; export const setApplication = value => { application = value }; export const getRouteRules = () => ({ routeRules: {} });`
        : args.path === '#nitro/runtime/app' ? 'export const resolveWebsocketHooks = () => ({})' : '', loader: 'js' }))
      builder.onResolve({ filter: /^(?:srvx\/node|crossws\/adapters\/vercel)$/ }, args => ({ path: runtimeRequire.resolve(args.path), external: true }))
    } }],
  })
  const directory = await mkdtemp(join(tmpdir(), 'mikka-vercel-authority-'))
  const file = join(directory, 'adapter.mjs')
  await writeFile(file, result.outputFiles[0].contents, { mode: 0o600 })
  try {
    const adapter = await import(pathToFileURL(file).href)
    return { adapter, close: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}

async function withHttpApplication(application: Application, work: (send: (headers?: OutgoingHttpHeaders, path?: string) => Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>) => Promise<void>) {
  const compiled = await officialAdapter()
  compiled.adapter.setApplication(application)
  const server = createServer((request, response) => {
    void compiled.adapter.default(request, response).catch((error: Error) => { response.destroy(error) })
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const send = (headers: OutgoingHttpHeaders = {}, path = '/mikka/api/rpc?kept=1') => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const values = Object.fromEntries(Object.entries({
        host: 'app.example.test', 'x-forwarded-host': 'app.example.test', 'x-forwarded-proto': 'https',
        origin, 'x-mikka-rpc': '1', 'content-type': 'text/plain', connection: 'close', ...headers,
      }).filter(([, value]) => value !== undefined))
      const rawHeaders = Object.entries(values).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).flatMap(item => [name, String(item)]))
      const request = sendHttp({ hostname: '127.0.0.1', port: address.port, method: 'POST', path, headers: rawHeaders }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.once('error', reject)
        response.once('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }))
      })
      request.once('error', reject); request.end('real HTTP request body')
    })
    await work(send)
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await compiled.close()
  }
}

const api = () => createApiHandler([{ path: '/mikka/api/rpc', template: '/api/rpc', source: 'authority-contract', methods: ['POST'], load: async () => ({
  POST: async (request: Request) => browserRpcOrigin(request, origin)
    ? Response.json({ url: request.url, body: await request.text() })
    : new Response(null, { status: 403 }),
}) }])

test('the official Vercel adapter preserves configured HTTPS authority for the existing strict RPC guard', { timeout: 10_000 }, async () => {
  const handler = api()
  const application: Application = { fetch: request => handler.fetch(request) }
  const environment = { BETTER_AUTH_URL: origin, VERCEL_URL: platformHost, VERCEL_PROJECT_PRODUCTION_URL: 'app.example.test' }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  try {
    // Invoke the same product plugins in their registered order, not a duplicate
    // of their environment wiring. The application slot contains no auth or DB.
    await authorityPlugin(application as Parameters<typeof authorityPlugin>[0])
    await securityHeadersPlugin(application as Parameters<typeof securityHeadersPlugin>[0])
    await withHttpApplication(application, async send => {
      const result = await send()
      assert.equal(result.status, 200)
      assert.equal(result.headers['x-content-type-options'], 'nosniff')
      assert.deepEqual(JSON.parse(result.body), { url: `${origin}/mikka/api/rpc?kept=1`, body: 'real HTTP request body' })
      const rejected = await send({ host: 'foreign.example.test' })
      assert.equal(rejected.status, 400)
      assert.equal(rejected.headers['x-content-type-options'], 'nosniff')
      assert.equal(rejected.headers['referrer-policy'], 'no-referrer')
    })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('the unadapted official Node adapter reproduces the HTTPS reverse-proxy RPC rejection', { timeout: 10_000 }, async () => {
  const application = api()
  await withHttpApplication({ fetch: request => application.fetch(request) }, async send => {
    assert.equal((await send()).status, 403)
  })
})

test('raw Host and proxy conflicts cannot add an authority; Origin remains independently enforced', { timeout: 10_000 }, async () => {
  const application = api()
  await withHttpApplication({ fetch: withVercelRequestAuthority(request => application.fetch(request), configuration) }, async send => {
    const rejectedHeaders: OutgoingHttpHeaders[] = [
      { host: 'foreign.example.test', 'x-vercel-deployment-url': platformHost },
      { host: ['app.example.test', 'app.example.test'] },
      { host: ['app.example.test', 'foreign.example.test'] },
      { 'x-forwarded-host': 'foreign.example.test' },
      { 'x-forwarded-host': ['app.example.test', 'app.example.test'] },
      { 'x-forwarded-proto': 'http' },
      { 'x-forwarded-proto': ['https', 'https'] },
      { forwarded: 'host=foreign.example.test;proto=https' },
    ]
    for (const headers of rejectedHeaders) {
      const result = await send(headers)
      assert.equal(result.status, 400)
      assert.equal(result.headers['cache-control'], 'no-store')
      assert.equal(result.body, '')
    }
    for (const value of ['https://foreign.example.test', 'null', undefined]) assert.equal((await send({ origin: value })).status, 403)
    assert.equal((await send({ authorization: 'Bearer fixture-not-a-credential' })).status, 403)
    assert.equal((await send({ 'x-mikka-session-cache': 'fixture-not-a-proof' })).status, 403)
    for (const path of ['http://foreign.example.test/mikka/api/rpc', '//foreign.example.test/mikka/api/rpc', '/mikka/\\foreign']) assert.equal((await send({}, path)).status, 400)
    // An allowed deployment domain cannot impersonate the canonical browser
    // origin; the unchanged RPC contract compares both values separately.
    assert.equal((await send({ host: platformHost, 'x-forwarded-host': platformHost })).status, 403)
  })
})

test('deployment-local Workflow ingress retains its own HTTPS URL, raw body and real waitUntil lifetime', { timeout: 10_000 }, async () => {
  const key = Symbol.for('@vercel/request-context')
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  const lifetime: Promise<unknown>[] = []
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  Object.defineProperty(globalThis, key, { configurable: true, value: { get: () => ({ waitUntil: (promise: Promise<unknown>) => lifetime.push(promise) }) } })
  let afterFinished = false, scopeWasNode = false
  const application = createApiHandler([{ path: '/.well-known/workflow/v1/flow', template: '/.well-known/workflow/v1/flow', source: 'workflow-ingress-contract', methods: ['POST'], load: async () => ({
    POST: async (request: Request) => {
      const original = requireRequestScope().request as ServerRequest
      scopeWasNode = original.runtime?.node?.req instanceof IncomingMessage && typeof original.waitUntil === 'function'
      after(async () => { started.resolve(); await release.promise; afterFinished = true })
      const response = Response.json({ url: request.url, body: await request.text(), origin: request.headers.get('origin') })
      response.headers.append('set-cookie', 'first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure; HttpOnly')
      response.headers.append('set-cookie', 'second=; Max-Age=0; Path=/mikka')
      return response
    },
  }) }])
  try {
    await withHttpApplication({ fetch: withVercelRequestAuthority(request => application.fetch(request), configuration) }, async send => {
      const result = await send({ host: platformHost, 'x-forwarded-host': platformHost, origin: undefined }, '/.well-known/workflow/v1/flow?kept=1')
      assert.equal(result.status, 200)
      assert.deepEqual(JSON.parse(result.body), { url: `https://${platformHost}/.well-known/workflow/v1/flow?kept=1`, body: 'real HTTP request body', origin: null })
      assert.deepEqual(result.headers['set-cookie'], ['first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure; HttpOnly', 'second=; Max-Age=0; Path=/mikka'])
      assert.equal(scopeWasNode, true)
      await started.promise
      assert.ok(lifetime.length > 0)
      assert.equal(afterFinished, false)
      release.resolve(); await Promise.all(lifetime)
      assert.equal(afterFinished, true)
    })
  } finally {
    release.resolve(); await Promise.all(lifetime)
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('legacy domain remains a fixed redirect without reaching application data', { timeout: 10_000 }, async () => {
  let invoked = false
  await withHttpApplication({ fetch: withVercelRequestAuthority(() => { invoked = true; return new Response('unreachable') }, { origin: 'https://app.aspectlylabs.com', legacyHost: 'mikka.aspectlylabs.com' }) }, async send => {
    const result = await send({ host: 'mikka.aspectlylabs.com', 'x-forwarded-host': 'mikka.aspectlylabs.com', origin: undefined }, '/settings?section=account')
    assert.equal(result.status, 308)
    assert.equal(result.headers.location, 'https://app.aspectlylabs.com/mikka/settings?section=account')
    assert.equal(invoked, false)
  })
})

test('a real HTTP/2 client can discover the configured self-host installation', { timeout: 10_000 }, async () => {
  const server = createHttp2Server()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  server.on('request', toNodeHandler(withNodeRequestAuthority(req => new Response(req.url), { origin })))
  const client = connectHttp2(origin)
  try {
    const get = async (headers: Record<string, string> = {}) => {
      const stream = client.request({ ':path': '/mikka/api/version', ...headers })
      const head = once(stream, 'response')
      stream.end()
      let body = ''
      for await (const chunk of stream) body += chunk
      return { status: (await head)[0][':status'], body }
    }
    const accepted = { status: 200, body: origin + '/mikka/api/version' }
    assert.deepEqual(await get(), accepted)
    assert.deepEqual(await get({ host: address.address + ':' + address.port }), accepted)
    assert.equal((await get({ ':authority': 'other.example.test' })).status, 400)
    assert.equal((await get({ host: 'other.example.test' })).status, 400)
  } finally {
    client.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('self-hosted Node accepts only its configured HTTPS authority behind a proxy', { timeout: 10_000 }, async () => {
  const application = api()
  await withHttpApplication({ fetch: withNodeRequestAuthority(request => application.fetch(request), { origin }) }, async send => {
    assert.equal((await send()).status, 200)
    assert.equal((await send({ host: 'other.example.test', 'x-forwarded-host': 'other.example.test' })).status, 400)
    assert.equal((await send({ 'x-forwarded-host': 'other.example.test' })).status, 400)
    assert.equal((await send({ 'x-forwarded-proto': 'http' })).status, 400)
    assert.equal((await send({ origin: 'https://other.example.test' })).status, 403)
  })
  for (const value of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.doesNotThrow(() => withNodeRequestAuthority(() => new Response(), { origin: value }))
  }
  for (const value of ['http://network.example.test', 'http://127.0.0.1.attacker.test', 'http://10.0.0.5:3000']) {
    assert.throws(() => withNodeRequestAuthority(() => new Response(), { origin: value }))
  }
})

test('authority registration is Vercel-production-only and configuration cannot contain arbitrary URL parts', async () => {
  const plugin = join(dirname(require.resolve('nitro/package.json')), 'unused')
  for (const options of [{ preset: 'node-server', dev: false }, { preset: 'vercel', dev: true }]) {
    const nitro = { options: { ...options, plugins: [plugin] } }
    vercelRequestAuthority(nitro)
    assert.deepEqual(nitro.options.plugins, [plugin])
  }
  const nitro = { options: { preset: 'vercel', dev: false, plugins: [plugin] } }
  vercelRequestAuthority(nitro); vercelRequestAuthority(nitro)
  assert.equal(nitro.options.plugins.length, 2)
  assert.match(nitro.options.plugins[0], /\/apps\/api\/plugins\/request-authority\.ts$/)
  for (const value of [undefined, 'http://app.example.test', 'https://user@app.example.test', `${origin}/path`, `${origin}?x=1`, `${origin}#fragment`]) {
    assert.throws(() => withVercelRequestAuthority(() => new Response(), { origin: value }), /API_VERCEL_AUTHORITY_CONFIG_INVALID/)
  }
  for (const deploymentHost of ['foreign.test/path', 'user@foreign.test', 'foreign.test:8443', 'https://foreign.test']) {
    assert.throws(() => withVercelRequestAuthority(() => new Response(), { origin, deploymentHost }), /API_VERCEL_AUTHORITY_CONFIG_INVALID/)
  }
  // Internal Nitro serverFetch has no IncomingMessage and must retain its own
  // explicit URL instead of manufacturing an external Node ingress identity.
  const internal = new Request('http://localhost/.well-known/workflow/v1/flow')
  const handler = withVercelRequestAuthority(request => { assert.equal(request, internal); return new Response(request.url) }, configuration)
  assert.equal(await (await handler(internal)).text(), internal.url)
})
