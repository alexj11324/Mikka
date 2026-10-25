import assert from 'node:assert/strict'
import test from 'node:test'
import { isEmailNotVerified, newPasswordProblem, recoveryMessageKey, requestPasswordReset, resetPageState, resetPassword, sendVerificationEmail, verifyPageState } from './auth-recovery'

test('requests fail as pending until the backend contract is wired', async () => {
  assert.deepEqual(await sendVerificationEmail({ email: 'a@example.com', callbackURL: '/verify-email' }), { ok: false, error: 'contract_pending' })
  assert.deepEqual(await requestPasswordReset({ email: 'a@example.com', redirectTo: '/reset-password' }), { ok: false, error: 'contract_pending' })
  assert.deepEqual(await resetPassword({ token: 't', newPassword: 'correct horse' }), { ok: false, error: 'contract_pending' })
})

test('treats no sign-in error as unverified before the contract lists its codes', () => {
  assert.equal(isEmailNotVerified({ code: 'EMAIL_NOT_VERIFIED' }), false)
  assert.equal(isEmailNotVerified(null), false)
})

test('maps recovery errors to message keys', () => {
  assert.equal(recoveryMessageKey('contract_pending'), 'recoveryUnavailable')
  assert.equal(recoveryMessageKey('invalid_token'), 'resetLinkInvalid')
  assert.equal(recoveryMessageKey('rate_limited'), 'tooManyRequests')
  assert.equal(recoveryMessageKey('failed'), 'submitFailed')
})

test('checks the new password length before the confirmation', () => {
  assert.equal(newPasswordProblem('short', 'short'), 'length')
  assert.equal(newPasswordProblem('x'.repeat(129), 'x'.repeat(129)), 'length')
  assert.equal(newPasswordProblem('long enough', 'long enougH'), 'mismatch')
  assert.equal(newPasswordProblem('long enough', 'long enough'), null)
})

test('opens the reset form only with a token and no link error', () => {
  assert.deepEqual(resetPageState({ token: ' abc ' }), { kind: 'form', token: 'abc' })
  assert.deepEqual(resetPageState({ token: ['abc', 'def'] }), { kind: 'form', token: 'abc' })
  assert.deepEqual(resetPageState({}), { kind: 'invalid' })
  assert.deepEqual(resetPageState({ token: '  ' }), { kind: 'invalid' })
  assert.deepEqual(resetPageState({ token: 'abc', error: 'INVALID_TOKEN' }), { kind: 'invalid' })
})

test('reads the verification page state from the link parameters', () => {
  assert.equal(verifyPageState({}), 'pending')
  assert.equal(verifyPageState({ verified: '1' }), 'verified')
  assert.equal(verifyPageState({ verified: '1', error: 'TOKEN_EXPIRED' }), 'invalid')
})
