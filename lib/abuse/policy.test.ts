import assert from 'node:assert/strict'
import test from 'node:test'
import {
  abuseAlertKinds,
  abuseLimits,
  FREE_ALLOWANCE_MICRO_USD,
  gatewayCost,
} from './policy'
import { normalizedEmail, disposableEmail, verifyTurnstile } from './signup'
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
