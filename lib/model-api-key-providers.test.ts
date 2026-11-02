import assert from 'node:assert/strict'
import test from 'node:test'
import { API_KEY_PRESETS, apiKeyEndpoint, apiKeyHarnesses, apiKeyProtocols } from './model-api-key-providers'

const preset = (provider: (typeof API_KEY_PRESETS)[number]) => ({ provider, protocol: 'anthropic' as const, baseUrl: null })

test('a preset serves every protocol its official API speaks; DeepSeek and Kimi both, so their keys run on both Agents', () => {
  assert.deepEqual(apiKeyHarnesses(preset('anthropic')), ['claude_code'])
  assert.deepEqual(apiKeyHarnesses(preset('openai')), ['codex'])
  assert.deepEqual(apiKeyHarnesses(preset('deepseek')), ['claude_code', 'codex'])
  assert.deepEqual(apiKeyHarnesses(preset('kimi')), ['claude_code', 'codex'])
  // A stored protocol on a preset row does not narrow it (older DeepSeek rows say anthropic).
  assert.deepEqual(apiKeyProtocols({ provider: 'deepseek', protocol: 'openai' }), ['anthropic', 'openai'])
})

test('each Agent talks to its own protocol\'s endpoint; a key that does not speak it has none', () => {
  assert.deepEqual(apiKeyEndpoint(preset('deepseek'), 'claude_code'), { protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic' })
  assert.deepEqual(apiKeyEndpoint(preset('deepseek'), 'codex'), { protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1' })
  assert.deepEqual(apiKeyEndpoint(preset('kimi'), 'claude_code'), { protocol: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic' })
  assert.deepEqual(apiKeyEndpoint(preset('kimi'), 'codex'), { protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1' })
  assert.equal(apiKeyEndpoint(preset('anthropic'), 'codex'), null)
  assert.equal(apiKeyEndpoint(preset('openai'), 'claude_code'), null)
})

test('a custom provider serves only the protocol the person picked, at its own base URL', () => {
  const gateway = { provider: 'custom' as const, protocol: 'openai' as const, baseUrl: 'https://gateway.example.com/v1' }
  assert.deepEqual(apiKeyHarnesses(gateway), ['codex'])
  assert.deepEqual(apiKeyEndpoint(gateway, 'codex'), { protocol: 'openai', baseUrl: 'https://gateway.example.com/v1' })
  assert.equal(apiKeyEndpoint(gateway, 'claude_code'), null)
  assert.deepEqual(apiKeyHarnesses({ ...gateway, protocol: 'anthropic' }), ['claude_code'])
})
