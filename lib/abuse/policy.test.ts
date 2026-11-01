import assert from 'node:assert/strict'
import test from 'node:test'
import {
  abuseAlertKinds,
  abuseLimits,
  FREE_ALLOWANCE_MICRO_USD,
  gatewayCost,
} from './policy'
import {
  signupClientIP,
  signupLimits,
  normalizedEmail,
  disposableEmail,
  verifyTurnstile,
} from './signup'
test('fixed $1 allowance, invalid caps never mean unlimited', () => {
  assert.equal(FREE_ALLOWANCE_MICRO_USD, 1e6)
  for (const value of ['', undefined, '0', '-1', 'NaN', 'Infinity', '1.2'])
    assert.equal(
      abuseLimits({ MIKKA_FREE_MODEL_DAILY_CENTS: value }).dailyMicroUsd,
      25e6,
    )
  assert.equal(
    abuseLimits({ MIKKA_FREE_MODEL_DAILY_CENTS: '100' }).dailyMicroUsd,
    1e6,
  )
})
test('cost metadata is rounded upwards, missing cost is never zero', () => {
  assert.equal(gatewayCost({ gateway: { cost: '0.0000001' } }), 1)
  assert.equal(gatewayCost({ gateway: { cost: 0 } }), 0)
  for (const value of [
    undefined,
    {},
    { gateway: { cost: -1 } },
    { gateway: { cost: 'NaN' } },
  ])
    assert.equal(gatewayCost(value), null)
})
test('Gmail aliases normalize; other domains keep dots; disposable subdomains are refused', () => {
  assert.equal(normalizedEmail('A.B+trial@Googlemail.com'), 'ab@gmail.com')
  assert.equal(normalizedEmail('A.B+trial@example.com'), 'a.b@example.com')
  assert.equal(disposableEmail('x@mailinator.com'), true)
  assert.equal(disposableEmail('x@sub.mailinator.com'), true)
  assert.equal(disposableEmail('x@gmail.com'), false)
})
test('Turnstile local skip, production missing config, invalid and valid provider token', async () => {
  await verifyTurnstile(undefined, {})
  await assert.rejects(
    verifyTurnstile(undefined, { VERCEL_ENV: 'production' }),
    /SIGNUP_VERIFICATION_UNAVAILABLE/,
  )
  await assert.rejects(
    verifyTurnstile(undefined, { TURNSTILE_SECRET_KEY: 'test' }),
    /TURNSTILE_REQUIRED/,
  )
  const mock = (data: unknown) =>
    (async () => Response.json(data)) as typeof fetch
  await verifyTurnstile(
    'synthetic',
    { TURNSTILE_SECRET_KEY: 'test' },
    mock({ success: true }),
  )
  await assert.rejects(
    verifyTurnstile(
      'synthetic',
      { TURNSTILE_SECRET_KEY: 'test' },
      mock({ success: false }),
    ),
    /TURNSTILE_INVALID/,
  )
  await assert.rejects(
    verifyTurnstile(
      'synthetic',
      { TURNSTILE_SECRET_KEY: 'test', VERCEL_ENV: 'production' },
      mock({ success: true, hostname: 'other.test' }),
    ),
    /TURNSTILE_INVALID/,
  )
  await verifyTurnstile(
    'synthetic',
    { TURNSTILE_SECRET_KEY: 'test', VERCEL_ENV: 'production' },
    mock({ success: true, hostname: 'app.aspectlylabs.com' }),
  )
})

test('alerts at 50%, 100% and strictly more than the first-use threshold', () => {
  const limits = abuseLimits({})
  assert.deepEqual(abuseAlertKinds(0, 50, limits), [])
  assert.deepEqual(abuseAlertKinds(12_500_000, 50, limits), ['half'])
  assert.deepEqual(abuseAlertKinds(25_000_000, 51, limits), [
    'half',
    'full',
    'signup_spike',
  ])
})

test('signup IP uses the trusted Vercel header and finite overrides never mean unlimited', () => {
  const headers = new Headers({
    'x-forwarded-for': '203.0.113.7, 10.0.0.1',
    'x-vercel-forwarded-for': '198.51.100.3',
  })
  assert.equal(signupClientIP(headers, { VERCEL: '1' }), '203.0.113.7')
  assert.equal(signupClientIP(headers, {}), 'local')
  assert.equal(signupLimits({ MIKKA_SIGNUP_IP_HOURLY: '0' }).signupIp, 5)
  assert.equal(signupLimits({ MIKKA_SIGNUP_IP_HOURLY: '1000' }).signupIp, 1000)
})

test('local test mode defaults to CI\'s limits; production and other databases keep 5 an hour (the rule: scripts/test-accounts/local-test-mode.test.mjs)', () => {
  const db = 'postgresql://e2e@127.0.0.1:5432/mikka_e2e'
  const local = { NODE_ENV: 'development', MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: db, MIKKA_DATABASE_URL: db }
  assert.deepEqual(signupLimits(local), { signupIp: 1000, signupGlobal: 10000, verificationIp: 1000, verificationGlobal: 10000 })
  // An explicit limit still wins, so rate-limit tests set their own low ones.
  assert.equal(signupLimits({ ...local, MIKKA_SIGNUP_IP_HOURLY: '2' }).signupIp, 2)
  for (const env of [
    { ...local, NODE_ENV: 'production' },
    { ...local, MIKKA_DATABASE_URL: 'postgresql://e2e@db.example.com:5432/mikka_e2e' },
    {},
  ]) assert.deepEqual(signupLimits(env), { signupIp: 5, signupGlobal: 100, verificationIp: 15, verificationGlobal: 300 }, JSON.stringify(env))
})
