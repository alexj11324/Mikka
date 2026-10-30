import assert from 'node:assert/strict'
import test from 'node:test'
import { createLoginFlow } from './login-flow'
import { loginView } from './login-outcome'

const NONCE = 'n'.repeat(43)
const SITE = 'https://dash.cloudflare.com'
const SECRET = 'hunter2-secret'
const ATTEMPT = '11111111-1111-4111-8111-111111111111'

function recorder(submit: { status: number; body: unknown }, attempt?: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/challenge')) return Response.json({ nonce: NONCE, origin: SITE, expiresIn: 300 })
    if (url.includes('/attempts/')) return Response.json(attempt)
    return Response.json(submit.body, { status: submit.status })
  }
  return { calls, flow: createLoginFlow('/mikka/api/threads/r/credentials', fetchImpl) }
}

test('BE-17 site outcomes map to card views', () => {
  assert.deepEqual(loginView(200, { status: 'signed_in', origin: SITE, attemptId: ATTEMPT }), { kind: 'signed_in' })
  assert.deepEqual(loginView(200, { status: 'rejected', reason: 'invalidCredentials' }), { kind: 'rejected', field: 'password', message: { key: 'invalidCredentials' } })
  assert.deepEqual(loginView(200, { status: 'rejected', reason: 'twoFactorInvalid' }), { kind: 'rejected', field: 'code', message: { key: 'twoFactorInvalid' } })
  assert.deepEqual(loginView(200, { status: 'rejected', reason: 'rateLimited', retryAfterSeconds: 29.2 }), { kind: 'rejected', field: null, retryAfterSeconds: 30, message: { key: 'rateLimitedFor', values: { seconds: 30 } } })
  assert.deepEqual(loginView(200, { status: 'rejected', reason: 'rateLimited' }), { kind: 'rejected', field: null, retryAfterSeconds: undefined, message: { key: 'rateLimited' } })
  assert.deepEqual(loginView(200, { status: 'rejected', reason: 'accountLocked' }), { kind: 'rejected', field: null, message: { key: 'accountLocked' } })
  assert.deepEqual(loginView(200, { status: 'needs_code', reason: 'twoFactorRequired' }), { kind: 'needs_code', label: { key: 'code' } })
  assert.deepEqual(loginView(200, { status: 'needs_code', reason: 'twoFactorRequired', channel: 'sms' }), { kind: 'needs_code', label: { key: 'codeSms' } })
  assert.deepEqual(loginView(200, { status: 'needs_code', channel: 'totp' }), { kind: 'needs_code', label: { key: 'codeTotp' } })
  assert.deepEqual(loginView(200, { status: 'needs_code', channel: 'email' }), { kind: 'needs_code', label: { key: 'codeEmail' } })
  assert.deepEqual(loginView(200, { status: 'needs_user', reason: 'captchaRequired' }), { kind: 'needs_user', message: { key: 'captchaRequired' } })
  assert.deepEqual(loginView(200, { status: 'unknown', reason: 'outcomeUnknown', attemptId: ATTEMPT }), { kind: 'unknown', message: { key: 'outcomeUnknown' }, attemptId: ATTEMPT })
})

test('open enums: unknown reasons and channels fall back to generic copy', () => {
  assert.deepEqual(loginView(200, { status: 'rejected', reason: 'brandNew' }), { kind: 'rejected', field: null, message: { key: 'rejected' } })
  assert.deepEqual(loginView(200, { status: 'needs_code', channel: 'carrierPigeon' }), { kind: 'needs_code', label: { key: 'code' } })
  assert.deepEqual(loginView(200, { status: 'rejected', reason: 'toString' }), { kind: 'rejected', field: null, message: { key: 'rejected' } })
  assert.deepEqual(loginView(500, { error: 'constructor' }), { kind: 'error', message: { key: 'failed' }, attemptId: null })
  assert.deepEqual(loginView(200, { status: 'needs_user', reason: 'brandNew' }), { kind: 'needs_user', message: { key: 'needsUser' } })
})

test('guarded, needs_login, submitted or no status are never signed in, wrong password or a code request', () => {
  for (const body of [{ status: 'guarded' }, { status: 'needs_login' }, { status: 'submitted' }, { status: 'session_applied' }, { status: 'resumed' }, {}, null]) {
    assert.equal(loginView(200, body).kind, 'waiting', JSON.stringify(body))
  }
})

test('Mikka errors keep their own copy', () => {
  assert.deepEqual(loginView(400, { error: 'credential_submission_invalid' }), { kind: 'error', message: { key: 'submissionInvalid' }, attemptId: null })
  assert.deepEqual(loginView(404, { error: 'credential_denied' }), { kind: 'error', message: { key: 'denied' }, attemptId: null })
  assert.deepEqual(loginView(409, { error: 'credential_login_pending', attemptId: ATTEMPT }), { kind: 'waiting', attemptId: ATTEMPT })
  assert.deepEqual(loginView(409, { error: 'credential_outcome_unknown', attemptId: ATTEMPT }), { kind: 'unknown', message: { key: 'outcomeUnknown' }, attemptId: ATTEMPT })
  assert.deepEqual(loginView(503, { error: 'credential_unavailable' }), { kind: 'error', message: { key: 'unavailable' }, attemptId: null })
  assert.deepEqual(loginView(500, { error: 'surprise' }), { kind: 'error', message: { key: 'failed' }, attemptId: null })
})

test('password submit fetches a challenge, then posts the nonce with CSRF headers', async () => {
  const { calls, flow } = recorder({ status: 200, body: { attemptId: ATTEMPT, status: 'signed_in', origin: SITE } })
  assert.deepEqual(await flow.password(SITE, 'alex@mikka.app', SECRET), { kind: 'signed_in' })
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

test('a code answered with needs_login is waiting, not a wrong code', async () => {
  const { calls, flow } = recorder({ status: 200, body: { status: 'needs_login' } })
  assert.equal((await flow.code(SITE, '482913')).kind, 'waiting')
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { nonce: NONCE, origin: SITE, code: '482913' })
})

test('recheck reads the attempt with a GET and no body', async () => {
  const { calls, flow } = recorder({ status: 200, body: null }, { status: 'signed_in', origin: SITE })
  assert.deepEqual(await flow.recheck(ATTEMPT), { kind: 'signed_in' })
  assert.equal(calls[0].url, `/mikka/api/threads/r/credentials/attempts/${ATTEMPT}`)
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.body, undefined)
  const still = recorder({ status: 200, body: null }, { status: 'unknown', reason: 'outcomeUnknown' })
  assert.deepEqual(await still.flow.recheck(ATTEMPT), { kind: 'unknown', message: { key: 'outcomeUnknown' }, attemptId: ATTEMPT })
})

test('failures never throw or surface the secret', async () => {
  const logged: unknown[] = []
  const original = { error: console.error, log: console.log, warn: console.warn }
  console.error = console.log = console.warn = (...args: unknown[]) => { logged.push(...args) }
  try {
    const down = createLoginFlow('/p', async () => { throw new Error('network') })
    assert.equal((await down.password(SITE, 'a', SECRET)).kind, 'error')
    const noNonce = createLoginFlow('/p', async () => Response.json({ error: 'credential_unavailable' }, { status: 503 }))
    assert.equal((await noNonce.password(SITE, 'a', SECRET)).kind, 'error')
  } finally { Object.assign(console, original) }
  assert.ok(!JSON.stringify(logged).includes(SECRET))
})
