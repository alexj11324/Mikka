// A failed sign-in says what went wrong, by error code (copy.md C-08).
import assert from 'node:assert/strict'
import test from 'node:test'
import englishMessages from '../../../messages/en.json'
import { signInErrorLine } from '../lib/sign-in-error.ts'

test('each better-auth code has its own line', () => {
  assert.equal(signInErrorLine({ code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 }), '邮箱或密码不正确')
  assert.equal(signInErrorLine({ code: 'USER_EMAIL_NOT_FOUND', status: 401 }), '邮箱或密码不正确')
  assert.equal(signInErrorLine({ code: 'INVALID_EMAIL', status: 400 }), '邮箱格式无效')
  assert.equal(signInErrorLine({ code: 'EMAIL_NOT_VERIFIED', status: 403 }), '邮箱未验证，请先完成邮件验证。')
  assert.equal(signInErrorLine({ status: 429 }), '尝试次数过多，请稍后再试')
})

test('an unknown failure falls back to a retry line', () => {
  assert.equal(signInErrorLine({ code: 'SOMETHING_NEW', status: 500 }), '登录失败。')
  assert.equal(signInErrorLine(undefined), '登录失败。')
})

test('English sign-in reports the same errors with shared English copy', () => {
  assert.equal(signInErrorLine({ code: 'INVALID_EMAIL_OR_PASSWORD' }, englishMessages.Auth), 'Incorrect email or password')
  assert.equal(signInErrorLine({ code: 'EMAIL_NOT_VERIFIED' }, englishMessages.Auth), 'Email is not verified. Complete verification from your email.')
  assert.equal(signInErrorLine({ code: 'INVALID_TOKEN' }, englishMessages.Auth), 'Sign-in failed.')
})
