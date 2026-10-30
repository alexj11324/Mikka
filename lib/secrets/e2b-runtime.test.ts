import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthenticationError, NotFoundError, RateLimitError, SandboxNotFoundError } from 'e2b'
import { classifyE2BError, computerTemplate } from './e2b-runtime'
import { E2BKeyError } from './e2b'

test('platform template never overrides the public BYO template', () => {
  assert.equal(computerTemplate({ E2B_COMPUTER_TEMPLATE: 'private-tpl', E2B_BYO_COMPUTER_TEMPLATE: 'public-tpl' }), 'public-tpl')
  assert.throws(() => computerTemplate({}), /e2b_template_unavailable/)
})
test('flag on: only the public BYO template; unset is e2b_template_unavailable', () => {
  assert.equal(computerTemplate({ MIKKA_BYO_E2B_KEY: '1', E2B_COMPUTER_TEMPLATE: 'private-tpl', E2B_BYO_COMPUTER_TEMPLATE: 'public-tpl' }), 'public-tpl')
  assert.throws(() => computerTemplate({ MIKKA_BYO_E2B_KEY: '1', E2B_COMPUTER_TEMPLATE: 'private-tpl' }), (error: unknown) => error instanceof E2BKeyError && error.code === 'e2b_template_unavailable')
})
test('E2B SDK errors map to stable codes', () => {
  assert.equal(classifyE2BError(new AuthenticationError('x'), false), 'e2b_key_invalid')
  assert.equal(classifyE2BError(Object.assign(new Error('x'), { status: 403 }), false), 'e2b_key_invalid')
  assert.equal(classifyE2BError(new RateLimitError('x'), true), 'e2b_limit_reached')
  assert.equal(classifyE2BError(new NotFoundError('template'), true), 'e2b_template_unavailable')
  assert.equal(classifyE2BError(new NotFoundError('sandbox'), false), null, 'a missing sandbox on connect is not a template problem')
  assert.equal(classifyE2BError(new SandboxNotFoundError('x'), true), null)
  assert.equal(classifyE2BError(new Error('boom'), true), null)
})
