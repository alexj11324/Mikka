import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthenticationError, NotFoundError, RateLimitError, SandboxNotFoundError } from 'e2b'
import { classifyE2BError, computerTemplate, taskTemplate } from './e2b-runtime'

test('new computers use the unchanged official desktop template', () => {
  assert.equal(computerTemplate({}), 'desktop')
  assert.equal(computerTemplate({ E2B_BYO_COMPUTER_TEMPLATE: 'desktop' }), 'desktop')
  assert.throws(() => computerTemplate({ E2B_BYO_COMPUTER_TEMPLATE: 'derived-template' }), /e2b_template_unavailable/)
})
test('task machines use official harness templates and reject derived replacements', () => {
  assert.equal(taskTemplate('claude_code', {}), 'claude')
  assert.equal(taskTemplate('codex', {}), 'codex')
  for (const harness of ['cursor', 'mock', '__proto__']) assert.throws(() => taskTemplate(harness, {}), /e2b_template_unavailable/)
  assert.throws(() => taskTemplate('codex', { E2B_CODEX_TEMPLATE: 'derived-template' }), /e2b_template_unavailable/)
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
