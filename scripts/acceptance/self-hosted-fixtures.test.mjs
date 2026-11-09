import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { assertFixtureEnvironment, assertOfficialWebCors, chatObservation, fixtureHttp, handoffCode, mailpitObservation, officialWebFixture, socketEvents } from './self-hosted-services.mjs'
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

test('Mailpit notifications coalesced as newline-delimited JSON in one WebSocket frame remain queued', async t => {
  const original = globalThis.WebSocket
  let peer
  class FixtureSocket extends EventTarget {
    static OPEN = 1
    readyState = 1
    constructor() { super(); peer = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  globalThis.WebSocket = FixtureSocket
  const mailbox = socketEvents('ws://fixture.invalid/api/events', undefined, { jsonLines: true })
  t.after(() => { mailbox.close(); globalThis.WebSocket = original })
  await mailbox.ready
  // Mailpit v1.27.4 writePump explicitly packs its queued JSON notifications
  // into a single frame with newline separators.
  const update = { Type: 'update', Data: { Total: 1 } }
  const arrival = { Type: 'new', Data: { Subject: 'verification', To: [{ Address: 'fixture@example.invalid' }] } }
  peer.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(update) + '\n' + JSON.stringify(arrival) }))
  assert.deepEqual(await mailbox.next(value => value.Type === 'new', 50), arrival)
  assert.deepEqual(await mailbox.next(value => value.Type === 'update', 50), update)
  assert.equal(mailbox.receivedCount, 2)
  const live = socketEvents('ws://fixture.invalid/live')
  t.after(() => live.close())
  await live.ready
  const notification = { kind: 'chat', text: 'a\nb' }
  peer.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(notification, null, 2) }))
  assert.deepEqual(await live.next(value => value.kind === 'chat', 50), notification)
  assert.equal(live.receivedCount, 1)
})

test('SMTP timeout evidence separates absent mail, recipient/subject mismatch and delivered mail without retaining private values', () => {
  const email = 'private-recipient@example.invalid', from = 'private-sender@example.invalid', subject = 'private-subject'
  const secret = 'private-authentication-link-token'
  const row = { ID: secret, Subject: subject, To: [{ Address: email }], From: { Address: from }, Snippet: secret, Text: secret }
  const expected = { read: 'ok', messages: 0, recipientMatches: 0, subjectMatches: 0, senderMatches: 0 }
  assert.deepEqual(mailpitObservation({ messages: [] }, { email, subject, from }), expected)
  const delivered = mailpitObservation({ messages: [row] }, { email, subject, from })
  assert.deepEqual(delivered, { read: 'ok', messages: 1, recipientMatches: 1, subjectMatches: 1, senderMatches: 1 })
  assert.deepEqual(mailpitObservation({ messages: [{ ...row, Subject: 'other' }] }, { email, subject, from }),
    { read: 'ok', messages: 1, recipientMatches: 1, subjectMatches: 0, senderMatches: 0 })
  assert.deepEqual(mailpitObservation({ messages: [{ ...row, To: [{ Address: 'other' }] }] }, { email, subject, from }),
    { read: 'ok', messages: 1, recipientMatches: 0, subjectMatches: 0, senderMatches: 0 })
  assert.deepEqual(mailpitObservation({ messages: [{ ...row, From: { Address: 'other' } }] }, { email, subject, from }),
    { read: 'ok', messages: 1, recipientMatches: 1, subjectMatches: 1, senderMatches: 0 })
  for (const value of [email, from, subject, secret]) assert.equal(JSON.stringify(delivered).includes(value), false)
})

test('unexpected or oversized Mailpit metadata stays unknown and cannot become delivery evidence', () => {
  const scope = { email: 'private', subject: 'private', from: 'private' }
  for (const inbox of [null, {}, { messages: 'private' }, { messages: Array(51).fill(null) }]) {
    assert.deepEqual(mailpitObservation(inbox, scope), { read: 'invalid' })
  }
  assert.deepEqual(mailpitObservation({ messages: [null, {}] }, scope),
    { read: 'ok', messages: 2, recipientMatches: 0, subjectMatches: 0, senderMatches: 0 })
})

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


test('official web fixture provides exact callback metadata without changing disposable network targets', () => {
  assert.deepEqual(officialWebFixture(fixture), {
    origin: 'https://app.aspectlylabs.com', callback: 'https://app.aspectlylabs.com/mikka/api/web/complete',
  })
  assert.deepEqual(officialWebFixture({ ...fixture, MIKKA_OFFICIAL_WEB_URL: 'https://isolated.example.test/custom/' }), {
    origin: 'https://isolated.example.test', callback: 'https://isolated.example.test/custom/api/web/complete',
  })
  for (const patch of [{ MIKKA_OFFICIAL_WEB_ENABLED: '0' }, { MIKKA_OFFICIAL_WEB_ENABLED: 'false' },
    { MIKKA_OFFICIAL_WEB_URL: 'http://isolated.example.test/custom' },
    { MIKKA_OFFICIAL_WEB_URL: 'https://credential@isolated.example.test/custom' },
    { MIKKA_OFFICIAL_WEB_URL: 'https://isolated.example.test/custom?redirect=elsewhere' },
    { MIKKA_OFFICIAL_WEB_URL: 'https://isolated.example.test/custom#fragment' }]) {
    assert.throws(() => officialWebFixture({ ...fixture, ...patch }))
  }
})

test('HTTP handoff driver refuses wrong callback/state, duplicate proof, token leakage and query credentials', () => {
  const { callback } = officialWebFixture(fixture)
  const state = 'fixture_state_123456789', code = 'a'.repeat(43)
  const target = `${callback}#${new URLSearchParams({ state, code })}`
  assert.equal(handoffCode(target, { callback, state }), code)
  for (const location of [
    target.replace('app.aspectlylabs.com', 'malicious.example.test'),
    `${callback}/#state=${state}&code=${code}`,
    `${callback}?code=${code}#state=${state}&code=${code}`,
    `${callback}#state=wrong_state&code=${code}`,
    `${target}&state=${state}`, `${target}&code=${code}`, `${target}&token=must-not-be-accepted`,
    `${callback}#state=${state}&code=short`,
  ]) assert.throws(() => handoffCode(location, { callback, state }), /SELF_HOSTED_WEB_HANDOFF_RETURN/)
})

test('HTTP acceptance requires exact CORS without cookie or native cache authority on every remote response', () => {
  const official = officialWebFixture(fixture).origin
  const headers = { 'access-control-allow-origin': official, vary: 'Origin, Authorization', 'cache-control': 'private, no-store' }
  assert.doesNotThrow(() => assertOfficialWebCors(new Response('{}', { headers }), official))
  for (const patch of [
    { 'access-control-allow-origin': '*' }, { 'access-control-allow-origin': 'https://malicious.example.test' },
    { 'access-control-allow-credentials': 'true' }, { 'access-control-allow-credentials': 'false' },
    { 'set-cookie': 'private=must-not-escape' }, { 'x-mikka-session-cache': 'must-not-escape' },
    { vary: 'Authorization' }, { 'cache-control': 'public, max-age=60' },
  ]) assert.throws(() => assertOfficialWebCors(new Response('{}', { headers: { ...headers, ...patch } }), official), /SELF_HOSTED_WEB_CORS_BOUNDARY/)
})
