import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { cronUnauthorized, verifyBearer } from './cron-auth'

const originalSecret = process.env.CRON_SECRET
const secret = 'source-only-cron-auth-secret'
const request = (authorization?: string) => new Request('https://preview.example.test/mikka/api/cron/schedules', authorization ? { headers: { authorization } } : {})

afterEach(() => {
  mock.restoreAll()
  if (originalSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = originalSecret
})

test('an unset CRON_SECRET answers 503 uncached, even with a bearer', async () => {
  delete process.env.CRON_SECRET
  for (const authorization of [undefined, 'Bearer ', `Bearer ${secret}`]) {
    const response = await cronUnauthorized(request(authorization))
    assert.equal(response?.status, 503)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { error: 'Cron is not configured' })
  }
})

test('a missing Authorization header answers 401 uncached with no body', async () => {
  process.env.CRON_SECRET = secret
  const response = await cronUnauthorized(request())
  assert.equal(response?.status, 401)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(await response.text(), '')
})

test('a wrong or malformed bearer answers 401 uncached', async () => {
  process.env.CRON_SECRET = secret
  for (const authorization of ['Bearer wrong', `Bearer ${secret}x`, `Bearer ${secret.slice(0, -1)}`, secret, `bearer ${secret}`, `Basic ${secret}`]) {
    const response = await cronUnauthorized(request(authorization))
    assert.equal(response?.status, 401, authorization)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
})

test('the exact bearer is let through', async () => {
  process.env.CRON_SECRET = secret
  assert.equal(await cronUnauthorized(request(`Bearer ${secret}`)), null)
})

test('the comparison stays constant-time: both sides are HMACed, whatever the length', async () => {
  const sign = mock.method(crypto.subtle, 'sign')
  for (const [value, expected] of [[`Bearer ${secret}`, true], ['Bearer x', false], [`Bearer ${secret}${'y'.repeat(200)}`, false]] as const) {
    sign.mock.resetCalls()
    assert.equal(await verifyBearer(value, secret), expected)
    assert.equal(sign.mock.callCount(), 2, 'the given token and the secret are each signed once before comparing')
    const [given, own] = sign.mock.calls.map(call => call.arguments)
    assert.equal(given![0], 'HMAC')
    assert.equal(given![1], own![1], 'one key for both digests')
  }
  sign.mock.resetCalls()
  assert.equal(await verifyBearer(null, secret), false)
  assert.equal(await verifyBearer(`Bearer ${secret}`, ''), false)
  assert.equal(sign.mock.callCount(), 0, 'nothing to compare without a bearer or a secret')
})
