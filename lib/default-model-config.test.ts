import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultModelConfigured } from './default-model-config'

test('default models require a complete LiteLLM route in every edition', () => {
  const env = { MIKKA_LITELLM_URL: 'http://127.0.0.1:4000/v1/', MIKKA_LITELLM_MASTER_KEY: 'fixture-key' }
  for (const edition of ['community', 'cloud']) {
    assert.equal(defaultModelConfigured({ ...env, MIKKA_EDITION: edition }), true)
    for (const name of Object.keys(env)) assert.equal(defaultModelConfigured({ ...env, [name]: undefined }), false)
  }
  for (const base of ['ftp://example.test/v1', 'https://key@example.test/v1', 'https://example.test/v1?key=secret']) {
    assert.equal(defaultModelConfigured({ ...env, MIKKA_LITELLM_URL: base }), false)
  }
  assert.equal(defaultModelConfigured({}), false)
  for (const name of ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'ZEROCAT_API_KEY', 'MIKKA_DEFAULT_MODEL_API_KEY']) {
    assert.equal(defaultModelConfigured({ [name]: 'retired-key', VERCEL: '1' }), false)
  }
})
