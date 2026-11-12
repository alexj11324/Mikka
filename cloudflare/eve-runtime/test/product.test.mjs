import assert from 'node:assert/strict'
import test from 'node:test'
import { productRequest } from '../runtime/product.mjs'

const endpoint = 'https://product.internal/mikka/api/internal/eve/tools'
const origin = 'https://app.example.test'
const request = (url = endpoint, method = 'POST', extra = {}) => new Request(url, { method,
  headers: { authorization: 'Bearer mev_fixture', 'x-mikka-product-capability': 'private-local', cookie: 'ignored', ...extra },
  ...(method === 'POST' ? { body: '{"operation":"prepare"}' } : {}) })

test('the shared host sends only the scoped product authorization to its selected API', async () => {
  let forwarded
  const result = await productRequest(request(), { fetch(r) { forwarded = r; return new Response(null, { status: 204 }) } }, origin, 'private-local')
  assert.equal(result.status, 204)
  assert.equal(forwarded.url, origin + '/mikka/api/internal/eve/tools')
  assert.equal(forwarded.redirect, 'error')
  assert.deepEqual(Object.fromEntries(forwarded.headers), { authorization: 'Bearer mev_fixture', 'content-type': 'application/json' })
  assert.deepEqual(await forwarded.json(), { operation: 'prepare' })
})

test('a missing immutable binding, wrong principal, wrong capability, or unrelated route stays closed', () => {
  assert.equal(productRequest(request(), undefined, origin, 'private-local').status, 503)
  for (const r of [request(endpoint, 'POST', { authorization: 'Bearer user' }), request(endpoint, 'POST', { 'x-mikka-product-capability': 'other' })]) {
    assert.equal(productRequest(r, undefined, origin, 'private-local').status, 403)
  }
  for (const r of [request(endpoint, 'GET'), request(endpoint + '?scope=other'), request(origin + '/mikka/api/internal/eve/tools'), request(endpoint + '/more')]) {
    assert.equal(productRequest(r, undefined, origin, 'private-local').status, 404)
  }
})

test('only the native Slack credential endpoint forwards a present grant proof', async () => {
  const url = endpoint.replace('/tools', '/slack-credential')
  const api = { async fetch(forwarded) {
    assert.equal(forwarded.url, origin + '/mikka/api/internal/eve/slack-credential')
    assert.equal(forwarded.headers.get('x-mikka-slack-grant'), 'scoped-proof')
    assert.equal(forwarded.headers.has('cookie'), false)
    return new Response(null, { status: 204 })
  } }
  assert.equal(productRequest(request(url), api, origin, 'private-local').status, 403)
  assert.equal((await productRequest(request(url, 'POST', { 'x-mikka-slack-grant': 'scoped-proof' }), api, origin, 'private-local')).status, 204)
  const tool = { fetch(forwarded) { assert.equal(forwarded.headers.has('x-mikka-slack-grant'), false); return new Response() } }
  await productRequest(request(endpoint, 'POST', { 'x-mikka-slack-grant': 'scoped-proof' }), tool, origin, 'private-local')
})
