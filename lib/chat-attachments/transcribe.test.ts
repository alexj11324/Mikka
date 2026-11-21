import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const credentials: unknown[] = []
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {} } })
mock.module(new URL('../model-api-keys.ts', import.meta.url).href, { namedExports: {
  usableApiKeys: async () => [{ id: 'key', provider: 'openai', models: ['whisper-1'] }],
  openApiKeyForChat: async () => ({ apiKey: 'synthetic-key', baseUrl: 'https://provider.fixture.invalid/v1' }),
} })
mock.module(new URL('../model-gateway/litellm-client.ts', import.meta.url).href, { namedExports: {
  createLiteLLMTranscriptionModel: (modelId: string, credential: unknown) => {
    assert.equal(modelId, 'whisper-1')
    credentials.push(credential)
    return 'litellm-transcription-fixture'
  },
} })
mock.module('ai', { namedExports: {
  transcribe: async ({ model }: { model: string }) => {
    assert.equal(model, 'litellm-transcription-fixture')
    return { text: 'Recognized speech' }
  },
} })

test('audio transcription sends the authorized key only through LiteLLM', async () => {
  const { transcribeChatAudio } = await import('./transcribe')
  assert.equal(await transcribeChatAudio('owner', 'workspace', new Uint8Array([1])), 'Recognized speech')
  assert.deepEqual(credentials, [{ apiKey: 'synthetic-key', baseUrl: 'https://provider.fixture.invalid/v1', provider: 'openai', modelId: 'whisper-1' }])
})
