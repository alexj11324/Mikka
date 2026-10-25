import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyFailure, newPasswordProblem, readResetLink, recoveryMessageKey } from './auth-recovery'

test('classifies the backend error responses', () => {
  assert.deepEqual(classifyFailure(400, 'INVALID_TOKEN', null), { ok: false, error: 'invalid_token' })
  assert.deepEqual(classifyFailure(400, 'PASSWORD_TOO_SHORT', null), { ok: false, error: 'password_length' })
  assert.deepEqual(classifyFailure(400, 'PASSWORD_TOO_LONG', null), { ok: false, error: 'password_length' })
  assert.deepEqual(classifyFailure(503, 'AUTH_EMAIL_DELIVERY_UNAVAILABLE', null), { ok: false, error: 'unavailable' })
  assert.deepEqual(classifyFailure(400, 'VALIDATION_ERROR', null), { ok: false, error: 'invalid_request' })
  assert.deepEqual(classifyFailure(403, undefined, null), { ok: false, error: 'invalid_request' })
  assert.deepEqual(classifyFailure(500, undefined, null), { ok: false, error: 'failed' })
})

test('reads the retry delay from a rate limit and falls back to the page cooldown', () => {
  assert.deepEqual(classifyFailure(429, undefined, '42'), { ok: false, error: 'rate_limited', retryAfter: 42 })
  assert.deepEqual(classifyFailure(429, undefined, null), { ok: false, error: 'rate_limited', retryAfter: 60 })
  assert.deepEqual(classifyFailure(429, undefined, 'soon'), { ok: false, error: 'rate_limited', retryAfter: 60 })
})

test('maps errors to message keys', () => {
  assert.equal(recoveryMessageKey('invalid_token'), 'resetLinkInvalid')
  assert.equal(recoveryMessageKey('password_length'), 'passwordLength')
  assert.equal(recoveryMessageKey('unavailable'), 'recoveryUnavailable')
  assert.equal(recoveryMessageKey('invalid_request'), 'submitFailed')
  assert.equal(recoveryMessageKey('failed'), 'connectionFailed')
})

test('checks the new password length in JavaScript string units before the confirmation', () => {
  assert.equal(newPasswordProblem('short', 'short'), 'length')
  assert.equal(newPasswordProblem('x'.repeat(129), 'x'.repeat(129)), 'length')
  assert.equal(newPasswordProblem('😀😀😀😀', '😀😀😀😀'), null)
  assert.equal(newPasswordProblem('long enough', 'long enougH'), 'mismatch')
  assert.equal(newPasswordProblem('long enough', 'long enough'), null)
})

test('takes the reset token out of the address', () => {
  assert.deepEqual(readResetLink('https://app.example.com/mikka/reset-password?token=abc'), { token: 'abc', cleaned: '/mikka/reset-password' })
  assert.deepEqual(readResetLink('https://app.example.com/mikka/en/reset-password?token=abc&x=1#top'), { token: 'abc', cleaned: '/mikka/en/reset-password?x=1#top' })
  assert.deepEqual(readResetLink('https://app.example.com/mikka/reset-password?error=INVALID_TOKEN'), { token: null, cleaned: '/mikka/reset-password' })
  assert.deepEqual(readResetLink('https://app.example.com/mikka/reset-password?token=abc&error=INVALID_TOKEN'), { token: null, cleaned: '/mikka/reset-password' })
  assert.deepEqual(readResetLink('https://app.example.com/mikka/reset-password?token=%20'), { token: null, cleaned: '/mikka/reset-password' })
})
