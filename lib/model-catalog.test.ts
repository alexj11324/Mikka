import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CATALOG_SNAPSHOT, FEATURED_MODELS, catalogIdFor, harnessFor, parseGatewayModel, vendorOf } from './model-catalog'
import { creditsOptionId, parseCreditsOption } from './bot-model-menu-view'

test('a Gateway entry becomes a catalogue model with prices per million tokens; non-chat models are left out', () => {
  assert.deepEqual(parseGatewayModel({
    id: 'deepseek/deepseek-v4-pro', owned_by: 'deepseek', name: 'DeepSeek V4 Pro', type: 'language', context_window: 1_000_000, max_tokens: 64_000,
    tags: ['reasoning', 'tool-use'], reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
    pricing: { input: '0.00000044', output: '0.00000087', input_cache_read: '0.000000036' },
  }), {
    id: 'deepseek/deepseek-v4-pro', vendor: 'deepseek', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, maxTokens: 64_000,
    pricing: { input: 0.44, output: 0.87, cacheRead: 0.036 }, tags: ['reasoning', 'tool-use'], reasoning: ['low', 'high'],
  })
  assert.equal(parseGatewayModel({ id: 'openai/gpt-image-2', type: 'image', tags: ['tool-use'] }), null)
  assert.equal(parseGatewayModel({ id: 'meta/llama-3.1-8b', type: 'language', tags: [] }), null, 'no tool use')
  assert.equal(parseGatewayModel({ id: 'anthropic/claude-opus-5-batch', type: 'language', tags: ['tool-use'] }), null, 'batch-only ids')
  assert.equal(parseGatewayModel({ id: 'Not A Catalogue Id', type: 'language', tags: ['tool-use'] }), null)
  const unpriced = parseGatewayModel({ id: 'zai/glm-5.3', type: 'language', tags: ['tool-use'] })
  assert.equal(unpriced?.pricing, null)
  assert.equal(unpriced?.name, 'glm-5.3')
})

test('the shipped snapshot holds every featured model, featured order first', () => {
  assert.deepEqual(CATALOG_SNAPSHOT.map(model => model.id), [...FEATURED_MODELS])
  for (const model of CATALOG_SNAPSHOT) assert.ok(model.pricing && model.pricing.output > 0, model.id)
})

test('a model\'s vendor comes from its id, so DeepSeek is DeepSeek on any source; OpenAI runs on Codex, the rest on Claude Code', () => {
  assert.equal(vendorOf('deepseek/deepseek-v4-pro'), 'deepseek')
  assert.equal(vendorOf('deepseek-v4-pro'), 'deepseek')
  assert.equal(vendorOf('moonshotai/kimi-k3'), 'moonshot')
  assert.equal(vendorOf('zai/glm-5.3'), 'zhipu')
  assert.equal(vendorOf('spacexai/grok-4.7'), 'xai')
  assert.equal(vendorOf('minimax/minimax-m3'), 'minimax')
  assert.equal(vendorOf('acme/some-model'), 'other')
  assert.equal(harnessFor('openai/gpt-6-luna'), 'codex')
  assert.equal(harnessFor('gpt-6-luna'), 'codex')
  assert.equal(harnessFor('anthropic/claude-opus-5.5'), 'claude_code')
  assert.equal(harnessFor('deepseek/deepseek-v4-pro'), 'claude_code')
})

test('subscription and API-key model ids map onto catalogue ids', () => {
  assert.equal(catalogIdFor('claude-opus-5-5'), 'anthropic/claude-opus-5.5')
  assert.equal(catalogIdFor('claude-haiku-5-5-20261015'), 'anthropic/claude-haiku-5.5')
  assert.equal(catalogIdFor('claude-opus-5'), 'anthropic/claude-opus-5')
  assert.equal(catalogIdFor('gpt-6-luna'), 'openai/gpt-6-luna')
  assert.equal(catalogIdFor('deepseek-v4-pro'), 'deepseek/deepseek-v4-pro')
  assert.equal(catalogIdFor('kimi-k3'), 'moonshotai/kimi-k3')
  assert.equal(catalogIdFor('anthropic/claude-sonnet-5.5'), 'anthropic/claude-sonnet-5.5')
  assert.equal(catalogIdFor('my-private-model'), null)
})

test('a Mikka 额度 menu id carries exactly one catalogue id', () => {
  assert.equal(creditsOptionId('anthropic/claude-opus-5.5'), 'credits:anthropic/claude-opus-5.5')
  assert.equal(parseCreditsOption('credits:anthropic/claude-opus-5.5'), 'anthropic/claude-opus-5.5')
  assert.equal(parseCreditsOption('credits:not a model'), null)
  assert.equal(parseCreditsOption('apikey:10000000-0000-4000-8000-000000000001:gpt'), null)
  assert.equal(parseCreditsOption('00000000-0000-0000-0000-000000000000'), null, 'the retired 「Mikka 默认」 id is no pick')
})
