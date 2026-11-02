// A failed sign-in says what went wrong, by error code (copy.md C-08).
import assert from 'node:assert/strict'
import test from 'node:test'
import { signInErrorLine } from '../lib/sign-in-error.ts'

test('each better-auth code has its own line', () => {
  assert.equal(signInErrorLine({ code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 }), '邮箱或密码不对。')
  assert.equal(signInErrorLine({ code: 'USER_EMAIL_NOT_FOUND', status: 401 }), '邮箱或密码不对。')
  assert.equal(signInErrorLine({ code: 'INVALID_EMAIL', status: 400 }), '邮箱格式无效。')
  assert.equal(signInErrorLine({ code: 'EMAIL_NOT_VERIFIED', status: 403 }), '邮箱还没验证，请先在邮件里点验证链接。')
  assert.equal(signInErrorLine({ status: 429 }), '尝试太频繁，请稍后再试。')
})

test('an unknown failure falls back to a retry line', () => {
  assert.equal(signInErrorLine({ code: 'SOMETHING_NEW', status: 500 }), '登录没成功，请稍后重试。')
  assert.equal(signInErrorLine(undefined), '登录没成功，请稍后重试。')
})
