import assert from 'node:assert/strict'
import test from 'node:test'
import { signupRefusal, turnstileHeaders, TURNSTILE_HEADER } from './signup-refusal'

test('maps the #527 sign-up codes to their messages', () => {
  assert.equal(signupRefusal(400, 'DISPOSABLE_EMAIL'), 'disposableEmail')
  assert.equal(signupRefusal(429, 'SIGNUP_RATE_LIMITED'), 'signupRateLimited')
  assert.equal(signupRefusal(429, undefined), 'signupRateLimited')
  assert.equal(signupRefusal(400, 'TURNSTILE_INVALID'), 'turnstileFailed')
  assert.equal(signupRefusal(400, 'TURNSTILE_REQUIRED'), 'turnstileFailed')
  assert.equal(signupRefusal(503, 'SIGNUP_VERIFICATION_UNAVAILABLE'), 'turnstileUnavailable')
  assert.equal(signupRefusal(422, 'EMAIL_ALREADY_REGISTERED'), 'emailRegistered')
})

test('leaves other failures to the generic message', () => {
  assert.equal(signupRefusal(400, 'VALIDATION_ERROR'), null)
  assert.equal(signupRefusal(500, undefined), null)
})

test('sends the Turnstile token only when the widget produced one', () => {
  assert.deepEqual(turnstileHeaders('tok'), { [TURNSTILE_HEADER]: 'tok' })
  assert.equal(TURNSTILE_HEADER, 'x-turnstile-token')
  assert.deepEqual(turnstileHeaders(null), {})
})
