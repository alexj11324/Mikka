import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brokerRequest, identityRequest } from './transport.mjs'

test('the identity intercept fixes its endpoint and removes all caller headers', async () => {
  let sent
  const binding = { async fetch(request) { sent = request; return Response.json({ token: 'fixture' }) } }
  const response = await identityRequest(new Request('https://identity.internal/token', {
    method: 'POST', headers: { authorization: 'caller', cookie: 'caller', subject: 'broker' },
  }), binding)
  assert.equal(response.status, 200)
  assert.equal(sent.url, 'https://identity.internal/token')
  assert.equal(sent.method, 'POST')
  assert.deepEqual([...sent.headers], [])
  assert.equal(sent.body, null)
  for (const [url, init] of [
    ['https://identity.internal/token?role=broker', { method: 'POST' }],
    ['https://other.internal/token', { method: 'POST' }],
    ['http://identity.internal/token', { method: 'POST' }],
    ['https://identity.internal/token', {}],
    ['https://identity.internal/token', { method: 'POST', body: '{}' }],
  ]) assert.equal((await identityRequest(new Request(url, init), binding)).status, 404)
  assert.equal((await identityRequest(new Request('https://identity.internal/token', { method: 'POST' }))).status, 503)
})

test('the private Broker transport forwards only the existing lease contract', async () => {
  let sent
  const response = await brokerRequest(new Request('https://broker.internal/api/fill', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: 'user', authorization: 'untrusted', 'x-forwarded-host': 'other' },
    body: '{ "lease": "one-time-capability" }',
  }), async request => { sent = request; return Response.json({ status: 'guarded', origin: 'https://example.com' }) })
  assert.deepEqual(await response.json(), { status: 'guarded', origin: 'https://example.com' })
  assert.equal(sent.url, 'https://broker.internal/api/fill')
  assert.equal(sent.method, 'POST')
  assert.deepEqual([...sent.headers], [['content-type', 'application/json']])
  assert.deepEqual(await sent.json(), { lease: 'one-time-capability' })
  assert.equal(sent.redirect, 'manual')
})

test('the Broker bridge rejects public authority, alternate operations, tenant overrides and oversized streams before dispatch', async () => {
  const send = () => assert.fail('Rejected request was dispatched')
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"lease":"fixture"}' }
  for (const url of ['https://public.example/api/fill', 'http://broker.internal/api/fill',
    'https://broker.internal/api/oidc', 'https://broker.internal/api/fill?role=app']) {
    assert.equal((await brokerRequest(new Request(url, options), send)).status, 404)
  }
  for (const [body, expected] of [
    ['{"lease":"fixture","userId":"other"}', 400], ['{"lease":42}', 400], ['{}', 400],
    ['invalid', 400], [JSON.stringify({ lease: 'x'.repeat(12_288) }), 413],
  ]) assert.equal((await brokerRequest(new Request('https://broker.internal/api/fill', { ...options, body }), send)).status, expected)
  assert.equal((await brokerRequest(new Request('https://broker.internal/api/fill', { ...options, headers: {} }), send)).status, 415)
})

test('private Broker transport failures return no provider body or lease', async () => {
  const response = await brokerRequest(new Request('https://broker.internal/api/fill', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"lease":"private"}',
  }), async () => { throw new Error('sensitive upstream body') })
  assert.equal(response.status, 503)
  assert.equal(await response.text(), '')
})
