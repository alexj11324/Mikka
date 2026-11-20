import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let allowed = true, opens = 0, calls = 0
const credentials: unknown[] = []
mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { pool: {} } })
mock.module(new URL('./model-api-keys.ts', import.meta.url).href, { namedExports: {
  openApiKeyForChat: async () => {
    opens++
    if (!allowed) throw Error('apiKeyNotFound')
    return { apiKey: 'synthetic-key', baseUrl: 'https://provider.fixture.invalid/v1', provider: 'custom' }
  },
} })
mock.module(new URL('./model-gateway/litellm-client.ts', import.meta.url).href, { namedExports: {
  createLiteLLMModel: (modelId: string, options: unknown) => {
    credentials.push(options)
    return { specificationVersion: 'v4', provider: 'litellm', modelId, supportedUrls: {},
      doGenerate: async () => { calls++; return { content: [] } } }
  },
} })
mock.module(new URL('./tracing/ai.ts', import.meta.url).href, { namedExports: { observedModel: (model: unknown) => model } })

test('API key chat routes through LiteLLM and reopens authorization at every call', async () => {
  const { resolveApiKeyChatModel } = await import('./model-api-key-chat')
  const model = await resolveApiKeyChatModel({ type: 'api_key', ownerId: 'owner', workspaceId: 'workspace',
    keyId: 'key', modelId: 'chosen-model', coordinator: true } as never)
  assert.equal(typeof model, 'object')
  if (typeof model !== 'object' || model.specificationVersion !== 'v4') throw Error('Expected a model')
  await model.doGenerate({ prompt: [] })
  assert.equal(opens, 2)
  assert.equal(calls, 1)
  assert.deepEqual(credentials[1], { user: 'workspace', credential: {
    apiKey: 'synthetic-key', baseUrl: 'https://provider.fixture.invalid/v1', provider: 'openai', modelId: 'chosen-model',
  } })
  allowed = false
  await assert.rejects(model.doGenerate({ prompt: [] }), /apiKeyNotFound/)
  assert.equal(calls, 1, 'revoked access cannot dispatch another model request')
})
