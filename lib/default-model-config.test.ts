import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultModelConfigured, selfHostedDefaultModelConfig } from './default-model-config'

test('community default model needs an administrator-owned complete route', () => {
  const env = { MIKKA_DEFAULT_MODEL_BASE_URL: 'http://127.0.0.1:8080/v1/', MIKKA_DEFAULT_MODEL_API_KEY: 'fixture-key', MIKKA_DEFAULT_MODEL_ID: 'local-model' }
  assert.deepEqual(selfHostedDefaultModelConfig(env), { baseURL: 'http://127.0.0.1:8080/v1', apiKey: 'fixture-key', modelId: 'local-model' })
  assert.equal(defaultModelConfigured(env), true)
  assert.equal(defaultModelConfigured({}), false)
  assert.equal(defaultModelConfigured({ VERCEL: '1' }), false)
  assert.equal(defaultModelConfigured({ AI_GATEWAY_API_KEY: 'own-key' }), true)
  for (const name of Object.keys(env)) assert.equal(selfHostedDefaultModelConfig({ ...env, [name]: undefined }), null)
  for (const base of ['ftp://example.test/v1', 'https://key@example.test/v1', 'https://example.test/v1?key=secret']) {
    assert.equal(selfHostedDefaultModelConfig({ ...env, MIKKA_DEFAULT_MODEL_BASE_URL: base }), null)
  }
  assert.equal(selfHostedDefaultModelConfig({ ...env, MIKKA_EDITION: 'cloud' }), null)
})
