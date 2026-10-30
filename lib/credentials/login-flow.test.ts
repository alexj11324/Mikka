import assert from 'node:assert/strict'
import test from 'node:test'
import { createLoginFlow, loginOutcome } from './login-flow'

const NONCE = 'n'.repeat(43)
const SITE = 'https://dash.cloudflare.com'
const SECRET = 'hunter2-secret'

function recorder(submit: { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/challenge')) return Response.json({ nonce: NONCE, origin: SITE, expiresIn: 300 })
    return Response.json(submit.body, { status: submit.status })
  }
  return { calls, flow: createLoginFlow('/mikka/api/threads/r/credentials', fetchImpl) }
}

test('maps backend results to card outcomes', () => {
  for (const status of ['submitted', 'session_applied', 'resumed']) assert.equal(loginOutcome(200, { status }), 'signed_in')
  assert.equal(loginOutcome(200, { status: 'guarded' }), 'needs_code')
  assert.equal(loginOutcome(200, { status: 'needs_login' }), 'rejected')
  assert.equal(loginOutcome(200, { status: 'surprise' }), 'failed')
  assert.equal(loginOutcome(503, { error: 'credential_unavailable' }), 'failed')
  assert.equal(loginOutcome(200, null), 'failed')
})

test('password submit fetches a challenge, then posts the nonce with CSRF headers', async () => {
  const { calls, flow } = recorder({ status: 200, body: { status: 'submitted', origin: SITE } })
  assert.equal(await flow.password(SITE, 'alex@mikka.app', SECRET), 'signed_in')
  assert.deepEqual(calls.map(call => call.url), ['/mikka/api/threads/r/credentials/challenge', '/mikka/api/threads/r/credentials'])
  for (const { init } of calls) {
    assert.equal(init.method, 'POST')
    assert.equal(init.cache, 'no-store')
    assert.deepEqual(init.headers, { 'content-type': 'application/json', 'x-mikka-credential': '1' })
  }
  assert.equal(JSON.parse(String(calls[0].init.body)).site, SITE)
  assert.ok(!String(calls[0].init.body).includes(SECRET), 'challenge never carries the secret')
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { nonce: NONCE, origin: SITE, username: 'alex@mikka.app', password: SECRET })
})

test('guarded after a password asks for a code; guarded after a code is a wrong code', async () => {
  assert.equal(await recorder({ status: 200, body: { status: 'guarded' } }).flow.password(SITE, 'a', SECRET), 'needs_code')
  const { calls, flow } = recorder({ status: 200, body: { status: 'guarded' } })
  assert.equal(await flow.code(SITE, '482913'), 'rejected')
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { nonce: NONCE, origin: SITE, code: '482913' })
})

test('failures never throw or surface the secret', async () => {
  const logged: unknown[] = []
  const original = { error: console.error, log: console.log, warn: console.warn }
  console.error = console.log = console.warn = (...args: unknown[]) => { logged.push(...args) }
  try {
    const down = createLoginFlow('/p', async () => { throw new Error('network') })
    assert.equal(await down.password(SITE, 'a', SECRET), 'failed')
    const noNonce = createLoginFlow('/p', async () => Response.json({ error: 'credential_unavailable' }, { status: 503 }))
    assert.equal(await noNonce.password(SITE, 'a', SECRET), 'failed')
    assert.equal(await recorder({ status: 409, body: { error: 'credential_outcome_unknown' } }).flow.password(SITE, 'a', SECRET), 'failed')
  } finally { Object.assign(console, original) }
  assert.ok(!JSON.stringify(logged).includes(SECRET))
})
