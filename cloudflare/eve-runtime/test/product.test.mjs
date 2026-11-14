import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { productRequest } from '../runtime/product.mjs'

const endpoint = 'https://product.internal/mikka/api/internal/eve/tools'
const slackEndpoint = endpoint.replace('/tools', '/slack-credential')
const origin = 'https://app.example.test'
const scope = JSON.stringify({ownerId:'owner',botId:'11111111-1111-4111-8111-111111111111',workspaceId:'22222222-2222-4222-8222-222222222222',surface:'web'})
const request = (url = endpoint, method = 'POST', extra = {}) => new Request(url, { method,
  headers: { 'x-mikka-eve-scope': scope, 'x-mikka-product-capability': 'private-local', cookie: 'ignored', ...extra },
  ...(method === 'POST' ? { body: '{"operation":"prepare"}' } : {}) })

test('the shared host sends only the existing Eve principal over private RPC to its selected API', async () => {
  let forwarded
  const result = await productRequest(request(), { eveProduct(r, principal) { assert.equal(principal, scope); forwarded = r; return new Response(null, { status: 204 }) } }, origin, 'private-local')
  assert.equal(result.status, 204)
  assert.equal(forwarded.url, origin + '/mikka/api/internal/eve/tools')
  assert.equal(forwarded.redirect, 'manual')
  assert.deepEqual(Object.fromEntries(forwarded.headers), { 'content-type': 'application/json' })
  assert.deepEqual(await forwarded.json(), { operation: 'prepare' })
})

test('a missing immutable binding, missing principal, wrong capability, or unrelated route stays closed', async () => {
  assert.equal((await productRequest(request(), undefined, origin, 'private-local')).status, 503)
  for (const r of [request(endpoint, 'POST', { 'x-mikka-eve-scope': '' }), request(endpoint, 'POST', { 'x-mikka-product-capability': 'other' })]) {
    assert.equal((await productRequest(r, undefined, origin, 'private-local')).status, 403)
  }
  for (const r of [request(endpoint, 'GET'), request(endpoint + '?scope=other'), request(origin + '/mikka/api/internal/eve/tools'), request(endpoint + '/more')]) {
    assert.equal((await productRequest(r, undefined, origin, 'private-local')).status, 404)
  }
})

test('workerd forwards the scoped body to its binding and rejects redirects', async t => {
  const require = createRequire(import.meta.url)
  const { Miniflare, convertV4MiniflareOptions } = createRequire(realpathSync(require.resolve('wrangler/package.json')))('miniflare')
  const directory = await mkdtemp(join(tmpdir(), 'eve-product-binding-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = await readFile(new URL('../runtime/product.mjs', import.meta.url), 'utf8')
  const options = { modules: true, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'] }
  const runtime = new Miniflare(convertV4MiniflareOptions({
    cf: false, host: '127.0.0.1', port: 0, resourcePersistencePath: directory,
    workers: [
      { ...options, name: 'eve', script: source + `
export default { fetch(request, env) {
          return productRequest(request, env.API, 'https://app.example.test', 'private-local')
        } }`, serviceBindings: { API: 'product' } },
      { ...options, name: 'product', script: `import {WorkerEntrypoint} from 'cloudflare:workers'; export default class extends WorkerEntrypoint { async eveProduct(request, scope) {
          if (new URL(request.url).hostname !== 'app.example.test') throw Error('unexpected redirect')
          const operation = await request.json()
          if (operation.redirect) return Response.redirect('https://outside.example.test', 307)
          return Response.json({ operation, scope, authorization: request.headers.get('authorization'),
            capability: request.headers.get('x-mikka-product-capability'), redirect: request.redirect,
            proof: request.headers.get('x-mikka-slack-grant'), path: new URL(request.url).pathname })
        } }` },
    ],
  }))
  t.after(() => runtime.dispose())
  const service = await runtime.getWorker('eve')
  const forwarded = await service.fetch(request())
  assert.equal(forwarded.status, 200)
  assert.deepEqual(await forwarded.json(), { operation: { operation: 'prepare' },
    scope, authorization: null, capability: null, redirect: 'manual', proof: null, path: new URL(endpoint).pathname })
  assert.equal((await service.fetch(request(slackEndpoint))).status, 403)
  const scoped = request(slackEndpoint, 'POST', { 'x-mikka-slack-grant': 'scoped-proof' })
  const slack = await service.fetch(scoped)
  assert.equal(slack.status, 200)
  assert.deepEqual(await slack.json(), { operation: { operation: 'prepare' }, scope, authorization: null,
    capability: null, redirect: 'manual', proof: 'scoped-proof', path: new URL(slackEndpoint).pathname })
  for (const target of [endpoint, slackEndpoint]) {
    const denied = await service.fetch(target, { method: 'POST', headers: scoped.headers,
      body: JSON.stringify({ redirect: true }) })
    assert.equal(denied.status, 502)
    assert.equal(denied.headers.get('location'), null)
    assert.equal(await denied.text(), '')
  }
})

test('every redirect class returns an empty 502 even if the upstream body reset during cleanup', async () => {
  for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
    let calls = 0
    let cancelled = false
    const body = status === 304 ? null : new ReadableStream({
      cancel() {
        cancelled = true
        if (status === 307) throw new Error('upstream reset')
      },
    })
    const result = await productRequest(request(), {
      eveProduct(forwarded, principal) {
        assert.equal(principal, scope)
        calls++
        assert.equal(forwarded.redirect, 'manual')
        return new Response(body, { status, headers: { location: 'https://elsewhere.example/receipt' } })
      },
    }, origin, 'private-local')
    assert.equal(calls, 1)
    assert.equal(cancelled, status !== 304)
    assert.equal(result.status, 502)
    assert.equal(result.headers.get('location'), null)
    assert.equal(await result.text(), '')
  }
})

test('only the native Slack credential endpoint forwards a present grant proof', async () => {
  const url = slackEndpoint
  const api = { async eveProduct(forwarded) {
    assert.equal(forwarded.url, origin + '/mikka/api/internal/eve/slack-credential')
    assert.equal(forwarded.headers.get('x-mikka-slack-grant'), 'scoped-proof')
    assert.equal(forwarded.headers.has('cookie'), false)
    return new Response(null, { status: 204 })
  } }
  assert.equal((await productRequest(request(url), api, origin, 'private-local')).status, 403)
  assert.equal((await productRequest(request(url, 'POST', { 'x-mikka-slack-grant': 'scoped-proof' }), api, origin, 'private-local')).status, 204)
  const tool = { eveProduct(forwarded) { assert.equal(forwarded.headers.has('x-mikka-slack-grant'), false); return new Response() } }
  await productRequest(request(endpoint, 'POST', { 'x-mikka-slack-grant': 'scoped-proof' }), tool, origin, 'private-local')
})
