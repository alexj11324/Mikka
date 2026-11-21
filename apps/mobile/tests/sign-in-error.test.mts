// A failed sign-in says what went wrong, by error code (copy.md C-08).
import assert from 'node:assert/strict'
import test from 'node:test'
import { getMobileMessages } from '../lib/messages.ts'
import { signInErrorLine } from '../lib/sign-in-error.ts'

// The device's catalog, and the Chinese one on demand: this suite runs under whatever locale the machine has.
const zh = getMobileMessages('zh-CN')
const englishMessages = getMobileMessages('en')

test('each better-auth code has its own line', () => {
  assert.equal(signInErrorLine({ code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 }, zh.Auth), zh.Auth.signInRefusal.invalidCredentials)
  assert.equal(signInErrorLine({ code: 'USER_EMAIL_NOT_FOUND', status: 401 }, zh.Auth), zh.Auth.signInRefusal.invalidCredentials)
  assert.equal(signInErrorLine({ code: 'INVALID_EMAIL', status: 400 }, zh.Auth), zh.Auth.emailInvalid)
  assert.equal(signInErrorLine({ code: 'EMAIL_NOT_VERIFIED', status: 403 }, zh.Auth), zh.Auth.mobileEmailNotVerified)
  assert.equal(signInErrorLine({ status: 429 }, zh.Auth), zh.Auth.signInRefusal.signInRateLimited)
})

test('an unknown failure falls back to a retry line', () => {
  assert.equal(signInErrorLine({ code: 'SOMETHING_NEW', status: 500 }, zh.Auth), zh.Auth.mobileSignInFailed)
  assert.equal(signInErrorLine(undefined, zh.Auth), zh.Auth.mobileSignInFailed)
})

test('English sign-in reports the same errors with shared English copy', () => {
  assert.equal(signInErrorLine({ code: 'INVALID_EMAIL_OR_PASSWORD' }, englishMessages.Auth), 'Incorrect email or password')
  assert.equal(signInErrorLine({ code: 'EMAIL_NOT_VERIFIED' }, englishMessages.Auth), 'Email is not verified. Complete verification from your email.')
  assert.equal(signInErrorLine({ code: 'INVALID_TOKEN' }, englishMessages.Auth), 'Sign-in failed.')
})
