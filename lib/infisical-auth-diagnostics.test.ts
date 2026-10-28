import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyUniversalAuthRejection } from './infisical-auth-diagnostics'
import { infisicalWorkloadToken, type InfisicalWorkloadFailure } from './infisical-workload'

// Synthetic injected responses only: the test launcher prohibits network access.
const secret = 'synthetic-private-value'
const failure = (message: string, reqId: string = 'req-fixture') => Response.json({
  statusCode: 401, error: 'UnauthorizedError', message, reqId, private: secret,
}, { status: 401 })

test('current workload interface classifies fixed errors without changing auth rejection or retry count', async () => {
  for (const [message, reason] of [
    ['Invalid credentials', 'invalid_credentials'],
    ['Access denied due to expired client secret', 'client_secret_expired'],
    ['Access denied due to client secret usage limit reached', 'client_secret_usage_limit'],
    ['This identity auth method is temporarily locked, please try again later', 'temporarily_locked'],
  ]) {
    let calls = 0
    const observed: InfisicalWorkloadFailure[] = []
    await assert.rejects(infisicalWorkloadToken('https://fixture.invalid', 'synthetic-id', secret, undefined,
      async () => { calls++; return failure(message) }, value => observed.push(value)),
    { message: 'infisical_identity_unavailable' })
    assert.equal(calls, 1) // No new retries, refresh loop or real authentication.
    assert.equal(observed.length, 1)
    assert.deepEqual(Object.keys(observed[0]).sort(), ['kind', 'reason', 'requestIdHash', 'status'])
    assert.equal(observed[0].reason, reason)
    assert.match(observed[0].requestIdHash!, /^[0-9a-f]{64}$/)
    for (const raw of [secret, message, 'req-fixture', 'synthetic-id']) assert(!JSON.stringify(observed).includes(raw))
  }
})

test('403 IP classification requires exact schema, status and fixed message', async () => {
  const body = { statusCode: 403, error: 'ForbiddenRequestError', message: 'You are not allowed to access this resource from the current IP address' }
  assert.deepEqual(await classifyUniversalAuthRejection(Response.json(body, { status: 403 }), []), { reason: 'ip_denied' })
  assert.deepEqual(await classifyUniversalAuthRejection(Response.json(body, { status: 401 }), []), { reason: 'unknown' })
})

test('untrusted text, malformed payloads and oversized bodies remain unknown', async () => {
  for (const response of [
    failure(`Invalid credentials ${secret}`, 'invalid id'),
    failure('x'.repeat(5000)),
    new Response(secret, { status: 401 }),
    new Response('{bad', { status: 401, headers: { 'content-type': 'application/json' } }),
    Response.json(null, { status: 401 }), Response.json([], { status: 401 }),
    new Response('{}', { status: 401, headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
  ]) assert.deepEqual(await classifyUniversalAuthRejection(response, [secret]), { reason: 'unknown' })
})

test('request identifiers reject oversized, injected and credential-colliding values', async () => {
  for (const id of ['req-' + 'a'.repeat(100), 'req-a\nprivate', 'https://fixture.invalid/private', 'req-secret']) {
    assert.deepEqual(await classifyUniversalAuthRejection(failure('Invalid credentials', id), ['req-secret']), { reason: 'invalid_credentials' })
  }
})

test('hostile streams are bounded and diagnostic callback failure cannot change rejection', async () => {
  for (const mode of ['never', 'many', 'large', 'error']) {
    let calls = 0, canceled = false
    const observed: InfisicalWorkloadFailure[] = []
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (mode === 'many') controller.enqueue(new Uint8Array())
        if (mode === 'large') controller.enqueue(new Uint8Array(4097))
        if (mode === 'error') controller.error(new Error(secret))
      },
      cancel() { canceled = true },
    })
    const started = performance.now()
    await assert.rejects(infisicalWorkloadToken('https://fixture.invalid', 'synthetic-id', secret, undefined,
      async () => { calls++; return new Response(stream, { status: 401, headers: { 'content-type': 'application/json' } }) },
      value => { observed.push(value); throw new Error(secret) }), { message: 'infisical_identity_unavailable' })
    assert.equal(calls, 1)
    assert(performance.now() - started < 1500)
    assert.deepEqual(observed, [{ kind: 'http', status: 401, reason: 'unknown' }])
    if (mode !== 'error') assert(canceled)
  }
})

test('success and transport failure preserve existing interface without emitting upstream text', async () => {
  const observed: InfisicalWorkloadFailure[] = []
  assert.equal(await infisicalWorkloadToken('https://fixture.invalid', 'id', secret, undefined,
    async () => Response.json({ accessToken: 'synthetic-token' }), value => observed.push(value)), 'synthetic-token')
  await assert.rejects(infisicalWorkloadToken('https://fixture.invalid', 'id', secret, undefined,
    async () => { throw new Error(secret) }, value => observed.push(value)), { message: 'infisical_identity_unavailable' })
  assert.deepEqual(observed, [])
})
