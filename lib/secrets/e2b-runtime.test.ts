import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthenticationError, NotFoundError, RateLimitError, SandboxNotFoundError } from 'e2b'
import { classifyE2BError, computerTemplate, taskTemplate } from './e2b-runtime'

test('new computers retain the official desktop fallback and refuse unverified replacements', () => {
  assert.equal(computerTemplate({}), 'desktop')
  assert.equal(computerTemplate({ E2B_BYO_COMPUTER_TEMPLATE: 'desktop' }), 'desktop')
  assert.throws(() => computerTemplate({ E2B_BYO_COMPUTER_TEMPLATE: 'derived-template' }), /e2b_template_unavailable/)
})
test('task machines retain official harness fallbacks and refuse unverified replacements', () => {
  assert.equal(taskTemplate('claude_code', {}), 'claude')
  assert.equal(taskTemplate('codex', {}), 'codex')
  for (const harness of ['cursor', 'mock', '__proto__']) assert.throws(() => taskTemplate(harness, {}), /e2b_template_unavailable/)
  assert.throws(() => taskTemplate('codex', { E2B_CODEX_TEMPLATE: 'derived-template' }), /e2b_template_unavailable/)
})
test('all three exact release-gated additive templates can be selected', () => {
  const templates = Object.fromEntries(['desktop', 'claude', 'codex'].map(kind => [kind,
    { templateId: `derived-${kind}`, baseTemplate: kind, preinstalled: true, models: [] }]))
  const env = { E2B_BYO_COMPUTER_TEMPLATE: 'derived-desktop', E2B_CLAUDE_TEMPLATE: 'derived-claude', E2B_CODEX_TEMPLATE: 'derived-codex',
    MIKKA_CLOUD_WORKER_SHA: 'a'.repeat(40), MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify({ version: 1, workerSha: 'a'.repeat(40), templates }) }
  assert.equal(computerTemplate(env), 'derived-desktop')
  assert.equal(taskTemplate('claude_code', env), 'derived-claude')
  assert.equal(taskTemplate('codex', env), 'derived-codex')
  assert.throws(() => taskTemplate('codex', { ...env, E2B_CODEX_TEMPLATE: 'different-image' }), /e2b_template_unavailable/)
  assert.throws(() => computerTemplate({ ...env, MIKKA_CLOUD_WORKER_SHA: 'b'.repeat(40) }), /e2b_template_unavailable/)
  const wrongBase = structuredClone(templates)
  wrongBase.claude.baseTemplate = 'codex'
  assert.throws(() => taskTemplate('claude_code', { ...env,
    MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify({ version: 1, workerSha: env.MIKKA_CLOUD_WORKER_SHA, templates: wrongBase }) }), /e2b_template_unavailable/)
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
