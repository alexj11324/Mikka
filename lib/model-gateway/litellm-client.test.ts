import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createLiteLLMModel, createLiteLLMTranscriptionModel, liteLLMCost, liteLLMGenerationId, liteLLMResponseCost } from './litellm-client'

const original = { MIKKA_LITELLM_URL: process.env.MIKKA_LITELLM_URL, MIKKA_LITELLM_MASTER_KEY: process.env.MIKKA_LITELLM_MASTER_KEY }

async function atProxy(t: TestContext, receiver: typeof fetch, run: () => Promise<void>) {
  process.env.MIKKA_LITELLM_URL = 'https://proxy.example/v1'
  process.env.MIKKA_LITELLM_MASTER_KEY = 'test-proxy-key'
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  t.mock.method(globalThis, 'fetch', receiver)
  await run()
}

const prompt: Parameters<ReturnType<typeof createLiteLLMModel>['doStream']>[0]['prompt'] = [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }]
const chunk = { id: 'model-response-id', object: 'chat.completion.chunk', created: 1, model: 'fixture/model' }

test('a reserved hosted call carries its own internal identity without replacing the original response receipt', async t => {
  const callId = 'mikka-hosted:00000000-0000-4000-8000-000000000001:wrun_native:step_model:1'
  await atProxy(t, async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('x-litellm-call-id'), callId)
    return Response.json({ id: 'provider-completion', object: 'chat.completion', created: 1, model: 'fixture/model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 } }, {
      headers: { 'x-litellm-call-id': callId, 'x-litellm-response-cost': '0.0000025' },
    })
  }, async () => {
    const result = await createLiteLLMModel('fixture/model', { user: 'workspace-fixture', callId }).doGenerate({ prompt: structuredClone(prompt) })
    assert.equal(liteLLMGenerationId(result.providerMetadata), callId)
    assert.equal(liteLLMCost(result.providerMetadata), 3)
    assert.equal(result.content[0].type, 'text')
  })
})

test('stream settlement reads the final usage cost, not the initial receipt placeholder', async t => {
  const events = [
    { ...chunk, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...chunk, choices: [], usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8, cost: 0.0000025 } },
  ]
  await atProxy(t, async (input, init) => {
    assert.equal(String(input), 'https://proxy.example/v1/chat/completions')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-proxy-key')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, 'mikka-credits/fixture/model')
    assert.equal(body.user, 'workspace-fixture')
    assert.equal(body.stream_options.include_usage, true)
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream', 'x-litellm-call-id': 'proxy-call', 'x-litellm-response-cost': '0' },
    })
  }, async () => {
    const result = await createLiteLLMModel('fixture/model', { user: 'workspace-fixture' }).doStream({ prompt: structuredClone(prompt) })
    const parts = await Array.fromAsync(result.stream)
    const finish = parts.find(part => part.type === 'finish')
    assert.equal(liteLLMCost(finish?.providerMetadata), 3)
    assert.equal(liteLLMGenerationId(finish?.providerMetadata), 'proxy-call')
    assert.equal(finish?.usage.inputTokens.total, 6)
    assert.ok(parts.every(part => part.type !== 'raw'))
  })
})

for (const returnedId of [undefined, 'another-proxy-call']) test(`a ${returnedId ? 'mismatched' : 'missing'} correlation ACK preserves the real stream and settled cost`, async t => {
  const callId = 'mikka-hosted:00000000-0000-4000-8000-000000000001:wrun_native:step_model:1'
  await atProxy(t, async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('x-litellm-call-id'), callId)
    const events = [
      { ...chunk, choices: [{ index: 0, delta: { content: 'paid content' }, finish_reason: null }] },
      { ...chunk, choices: [], usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8, cost: 0.0000025 } },
    ]
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream', ...(returnedId ? { 'x-litellm-call-id': returnedId } : {}) },
    })
  }, async () => {
    const result = await createLiteLLMModel('fixture/model', { callId }).doStream({ prompt: structuredClone(prompt) })
    const parts = await Array.fromAsync(result.stream)
    assert.ok(parts.some(part => part.type === 'text-delta' && part.delta === 'paid content'))
    const finish = parts.find(part => part.type === 'finish')
    assert.equal(liteLLMCost(finish?.providerMetadata), 3)
    assert.equal(liteLLMGenerationId(finish?.providerMetadata), returnedId)
  })
})

test('caller headers cannot supply a hosted identity without an actual server reservation', async t => {
  await atProxy(t, async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('x-litellm-call-id'), null)
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }, async () => {
    const result = await createLiteLLMModel('fixture/model').doStream({ prompt: structuredClone(prompt),
      headers: { 'x-litellm-call-id': 'mikka-hosted:00000000-0000-4000-8000-000000000001' } })
    await result.stream.pipeTo(new WritableStream())
  })
})

test('transcription keeps the provider credential in the private proxy request', async t => {
  const credential = { modelId: 'whisper-1', provider: 'openai' as const, apiKey: 'person-key', baseUrl: 'https://provider.example/v1' }
  await atProxy(t, async (input, init) => {
    assert.equal(String(input), 'https://proxy.example/v1/audio/transcriptions')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-proxy-key')
    assert.equal(new Headers(init?.headers).get('x-litellm-num-retries'), '0')
    assert.ok(init?.body instanceof FormData)
    assert.equal(init.body.get('model'), 'openai/whisper-1')
    assert.equal(init.body.get('api_key'), 'person-key')
    assert.equal(init.body.get('api_base'), 'https://provider.example/v1')
    assert.equal(init.body.get('num_retries'), null)
    return Response.json({ text: 'fixture transcript' })
  }, async () => {
    const result = await createLiteLLMTranscriptionModel('whisper-1', credential).doGenerate({
      audio: Uint8Array.of(1, 2, 3), mediaType: 'audio/wav',
    })
    assert.equal(result.text, 'fixture transcript')
  })
})

test('proxy cost is rounded up to microdollars and malformed receipts are unknown', () => {
  assert.equal(liteLLMResponseCost({ 'x-litellm-response-cost': '0.0000001' }), 1)
  assert.equal(liteLLMResponseCost({ 'x-litellm-response-cost': '-0.0000001' }), null)
  assert.equal(liteLLMResponseCost(undefined), null)
})
