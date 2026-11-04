import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { assertFlashTestModel, assertTestModelRequest } from './test-model-policy.mjs'

test('live tests allow only listed Flash IDs and reject Pro, other models and missing models', () => {
  for (const model of ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash']) assert.doesNotThrow(() => assertFlashTestModel(model))
  for (const model of ['deepseek-v4-pro', 'DeepSeek-V4-Pro', 'deepseek/deepseek-v4-pro', 'deepseek-v4.1-pro', 'deepseek-pro', 'openai/gpt-4.1-mini', undefined, '']) assert.throws(() => assertFlashTestModel(model), /Flash-only test policy/)
})

test('effective Gateway header and JSON model must both be Flash', async () => {
  for (const headers of [{ 'ai-language-model-id': 'deepseek/deepseek-v4-pro' }, { 'ai-model-id': 'deepseek/deepseek-v4-pro' }]) {
    await assert.rejects(() => assertTestModelRequest(new Request('https://ai-gateway.vercel.sh/v4/ai/language-model', { method: 'POST', headers, body: '{}' })), /Flash-only test policy/)
  }
  await assert.rejects(() => assertTestModelRequest(new Request('https://ai-gateway.vercel.sh/v1/responses', { method: 'POST', headers: { 'ai-model-id': 'deepseek/deepseek-flash' }, body: JSON.stringify({ model: 'deepseek-v4-pro' }) })), /Flash-only test policy/)
  await assertTestModelRequest(new Request('https://api.deepseek.com/v1/models'))
})

test('model preflight exits nonzero for Pro before a driver can spend credits', () => {
  const script = new URL('./assert-test-model.mjs', import.meta.url)
  const rejected = spawnSync(process.execPath, [script.pathname, 'deepseek-v4-pro'], { encoding: 'utf8' })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /Flash-only test policy/)
  assert.equal(spawnSync(process.execPath, [script.pathname, 'deepseek-flash']).status, 0)
})

test('Coordinator evaluation rejects Pro even when credentials are absent', () => {
  const env = { ...process.env, COORDINATOR_EVAL_MODEL: 'deepseek-v4-pro' }
  delete env.NODE_TEST_CONTEXT
  delete env.DEEPSEEK_API_KEY
  delete env.AI_GATEWAY_API_KEY
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', './tests/support/server-only.mjs', '--import', 'tsx', '--test', 'scripts/coordinator-eval.test.mts'], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /Flash-only test policy/)
})


test('application chat submissions are not mistaken for provider model calls', async () => {
  for (const path of ['/mikka/api/coordinator/messages', '/mikka/api/mobile/chat']) {
    await assertTestModelRequest(new Request('http://127.0.0.1:3000' + path, { method: 'POST', body: JSON.stringify({ text: 'Run the Flash acceptance task' }) }))
  }
})

test('conflicting Gateway model headers cannot hide Pro behind Flash', async () => {
  await assert.rejects(() => assertTestModelRequest(new Request('https://ai-gateway.vercel.sh/v4/ai/language-model', {
    method: 'POST', body: '{}',
    headers: { 'ai-language-model-id': 'deepseek/deepseek-flash', 'ai-model-id': 'deepseek/deepseek-v4-pro' },
  })), /Flash-only test policy/)
})
