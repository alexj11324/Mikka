import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { assertFixtureEnvironment, chatObservation, fixtureHttp } from './self-hosted-services.mjs'
import { createModelFixture } from './self-hosted-model.mjs'

const fixture = {
  MIKKA_SELF_HOSTED_ACCEPTANCE: '1', BETTER_AUTH_URL: 'http://localhost:3000',
  MIKKA_EXPECTED_REVISION: '1'.repeat(40),
  MIKKA_DATABASE_URL: 'postgres://mikka:isolated@postgres:5432/mikka',
  DATABASE_URL: 'postgres://mikka:isolated@postgres:5432/mikka',
  SMTP_URL: 'smtp://mailpit:1025', S3_ENDPOINT: 'http://minio:9000', S3_BUCKET: 'mikka-selfhost-ci',
  S3_ACCESS_KEY_ID: 'selfhost-ci', S3_SECRET_ACCESS_KEY: Buffer.alloc(32, 1).toString('base64'), S3_REGION: 'us-east-1',
  MIKKA_DEFAULT_MODEL_BASE_URL: 'http://model:8080/v1', MIKKA_DEFAULT_MODEL_API_KEY: 'synthetic-selfhost-only', MIKKA_DEFAULT_MODEL_ID: 'selfhost-ci',
}

test('the mutating driver refuses public origins, remote databases, cloud credentials and real model targets', () => {
  assert.doesNotThrow(() => assertFixtureEnvironment(fixture))
  for (const overrides of [
    { MIKKA_SELF_HOSTED_ACCEPTANCE: undefined }, { BETTER_AUTH_URL: 'https://app.aspectlylabs.com' },
    { MIKKA_EDITION: 'cloud' }, { MIKKA_EXPECTED_REVISION: 'main' },
    { MIKKA_DATABASE_URL: 'postgres://mikka:isolated@production.example.test:5432/mikka' },
    { DATABASE_URL: 'postgres://mikka:isolated@postgres:5432/other' },
    { SMTP_URL: 'smtp://external.example.test:1025' }, { S3_ENDPOINT: 'https://storage.example.test' },
    { MIKKA_DEFAULT_MODEL_BASE_URL: 'https://api.openai.com/v1' },
    { MIKKA_DEFAULT_MODEL_API_KEY: 'real-key' }, { VERCEL: '1' }, { AI_GATEWAY_API_KEY: 'real-key' },
    { GITHUB_APP_PRIVATE_KEY: 'real-key' }, { DEVICE_GATEWAY_URL: 'https://gateway.example.test' },
  ]) assert.throws(() => assertFixtureEnvironment({ ...fixture, ...overrides }))
})

test('chat diagnostics distinguish unavailable reads without retaining error, content or identity values', () => {
  const secret = 'private-fixture-value-that-must-not-be-retained'
  const observed = chatObservation({ enabled: true, working: false, error: null, failure: { kind: 'failed', message: secret },
    streamRunId: secret, items: [{ from: 'person', text: secret, id: secret }] }, 'SELF_HOSTED_REPLY_01')
  assert.deepEqual(observed, { enabled: true, working: false, error: 'none', failure: 'failed', failureCode: 'none',
    itemCount: 1, lastFrom: 'person', lastPending: false, streamPresent: true, expectedReplyPresent: false })
  const unknown = chatObservation({ enabled: secret, working: secret, error: secret,
    failure: { kind: secret, code: secret }, items: [{ from: secret, text: secret, id: secret }] }, 'SELF_HOSTED_REPLY_01')
  assert.equal(unknown.error, 'unclassified')
  assert.equal(unknown.failure, 'unclassified')
  assert.equal(unknown.failureCode, 'unclassified')
  assert.equal(unknown.lastFrom, 'unclassified')
  assert.equal(JSON.stringify([observed, unknown]).includes(secret), false)
  const explicit = chatObservation({ enabled: true, working: false, error: 'wake_failed', failure: { kind: 'wake', code: 'wake_failed' } }, 'SELF_HOSTED_REPLY_01')
  assert.equal(explicit.error, 'wake_failed')
  assert.equal(explicit.failureCode, 'wake_failed')
})

test('replica requests preserve the canonical authority, individual cookies and manual redirects', async t => {
  const seen = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    seen.push({ host: request.headers.host, origin: request.headers.origin, cookie: request.headers.cookie,
      method: request.method, path: request.url, body: Buffer.concat(chunks).toString() })
    response.writeHead(302, { location: '/must-not-follow', 'set-cookie': ['session=first; HttpOnly', 'verified=yes; SameSite=Lax'] })
    response.end('verification accepted')
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const response = await fixtureHttp(`http://127.0.0.1:${server.address().port}/mikka/api/auth/verify-email`, {
    method: 'POST', headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: 'previous=kept' },
    body: 'synthetic request', signal: AbortSignal.timeout(5_000),
  })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/must-not-follow')
  assert.deepEqual(response.headers.getSetCookie(), ['session=first; HttpOnly', 'verified=yes; SameSite=Lax'])
  assert.equal(await response.text(), 'verification accepted')
  assert.deepEqual(seen, [{ host: 'localhost:3000', origin: 'http://localhost:3000', cookie: 'previous=kept',
    method: 'POST', path: '/mikka/api/auth/verify-email', body: 'synthetic request' }])
  assert.throws(() => fixtureHttp('https://example.test/mikka/'), /HTTP_FIXTURE_PROTOCOL/)
})

test('the isolated model supports ordinary and streaming OpenAI requests with explicit synthetic receipts', async t => {
  const server = createModelFixture().listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (body, authorization = 'Bearer synthetic-selfhost-only') => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const response = await call({ model: 'selfhost-ci', messages: [{ role: 'user', content: 'selfhost_turn_01' }] })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, 'SELF_HOSTED_REPLY_01')
  const stream = await call({ model: 'selfhost-ci', messages: [{ role: 'user', content: 'selfhost_turn_02' }], stream: true })
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  const chunks = (await stream.text()).split('\n\n').filter(Boolean)
  assert.equal(JSON.parse(chunks[0].slice(6)).choices[0].delta.content, 'SELF_HOSTED_REPLY_02')
  assert.equal(JSON.parse(chunks[1].slice(6)).choices[0].finish_reason, 'stop')
  assert.equal(chunks[2], 'data: [DONE]')
  const refused = await call({ model: 'selfhost-ci', messages: [] }, 'Bearer other')
  assert.equal(refused.status, 400); await refused.body.cancel()
  assert.deepEqual(await (await fetch(`${base}/evidence`)).json(), { synthetic: true, calls: 2, turns: ['01', '02'] })
})
