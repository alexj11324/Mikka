import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, jsonSchema, stepCountIs, streamText, tool } from 'ai'
import { createLiteLLMModel, liteLLMCost, liteLLMGenerationId } from '../../lib/model-gateway/litellm-client.ts'
import { localModelAnswer } from '../../scripts/dev-local/model.mjs'
import { FAKE_LITELLM_KEY, FAKE_MODEL_KEY, startFakeLiteLlm } from './litellm.mjs'

test('the production LiteLLM client preserves streamed and nonstreamed billing receipts over real HTTP', async t => {
  const server = await startFakeLiteLlm({ answer: localModelAnswer })
  t.after(() => server.close())
  const previous = { MIKKA_LITELLM_URL: process.env.MIKKA_LITELLM_URL, MIKKA_LITELLM_MASTER_KEY: process.env.MIKKA_LITELLM_MASTER_KEY }
  process.env.MIKKA_LITELLM_URL = server.url
  process.env.MIKKA_LITELLM_MASTER_KEY = FAKE_LITELLM_KEY
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const model = createLiteLLMModel('mikka-default')
  const response = await generateText({ model, prompt: '/echo receipt', maxRetries: 0 })
  assert.equal(response.text, 'Local model: receipt')
  assert.equal(liteLLMCost(response.providerMetadata), 1234)
  assert.match(liteLLMGenerationId(response.providerMetadata), /^fake-litellm-/)
  const streamed = streamText({ model, prompt: '/echo streamed receipt', maxRetries: 0 })
  assert.equal(await streamed.text, 'Local model: streamed receipt')
  assert.equal(liteLLMCost(await streamed.providerMetadata), 1234)
  assert.equal((await streamed.usage).inputTokens, 11)
  const ownKey = createLiteLLMModel('deepseek-flash', { credential: { provider: 'openai', modelId: 'deepseek-flash', apiKey: FAKE_MODEL_KEY, baseUrl: 'https://never-contacted.invalid/v1' } })
  assert.equal((await generateText({ model: ownKey, prompt: '/echo placeholder BYOK', maxRetries: 0 })).text, 'Local model: placeholder BYOK')
  await assert.rejects(generateText({ model, prompt: 'unregistered request', maxRetries: 0 }), error => error.statusCode === 422)
})

test('the real Responses SDK parses fragmented tool arguments and executes the registered tool exactly once', async t => {
  const server = await startFakeLiteLlm({ answer: localModelAnswer })
  t.after(() => server.close())
  const model = createOpenAI({ baseURL: `${server.url}/v1`, apiKey: FAKE_LITELLM_KEY }).responses('mikka-default')
  const calls = []
  const result = streamText({ model, prompt: '/tool echo {"word":"actual response SDK"}', maxRetries: 0, stopWhen: stepCountIs(2),
    tools: { echo: tool({ inputSchema: jsonSchema({ type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false }), execute: async input => { calls.push(input); return { echoed: input.word } } }) },
  })
  assert.equal(await result.text, 'echo: {"echoed":"actual response SDK"}')
  assert.deepEqual(calls, [{ word: 'actual response SDK' }])
  assert.deepEqual((await result.steps).map(step => step.usage.outputTokens), [7, 7])
  assert.equal((await result.totalUsage).outputTokens, 14)
})
