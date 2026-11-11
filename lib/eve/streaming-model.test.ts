import assert from 'node:assert/strict'
import test from 'node:test'
import { generateText, type LanguageModel } from 'ai'
import { streamingModel } from './streaming-model'

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type Part = Awaited<ReturnType<Model['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never
const usage = { inputTokens: { total: 10, noCache: 4, cacheRead: 6, cacheWrite: 0 }, outputTokens: { total: 3, text: 2, reasoning: 1 } }
const finish: Part = { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'end_turn' } }
function fixture(parts: Part[], observed?: (options: Parameters<Model['doStream']>[0]) => void): Model {
  return { specificationVersion: 'v4', provider: 'mikka.subscription', modelId: 'fixture-streaming-only', supportedUrls: {},
    doGenerate: async () => { throw new Error('subscription_stream_required') },
    doStream: async options => {
      observed?.(options)
      return { stream: new ReadableStream<Part>({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } }) }
    },
  }
}

test('the real SDK can compact through a streaming-only subscription without another model or loop', async () => {
  let calls = 0
  const model = streamingModel(fixture([
    { type: 'stream-start', warnings: [] },
    { type: 'reasoning-start', id: 'reason' }, { type: 'reasoning-delta', id: 'reason', delta: 'Think.' }, { type: 'reasoning-end', id: 'reason' },
    { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'The saved ' }, { type: 'text-delta', id: 'answer', delta: 'summary.' }, { type: 'text-end', id: 'answer' }, finish,
  ], () => calls++))
  const result = await generateText({ model, prompt: 'Summarize the earlier conversation.', maxRetries: 0 })
  assert.equal(result.text, 'The saved summary.')
  assert.equal(result.reasoningText, 'Think.')
  assert.equal(result.usage.inputTokens, 10)
  assert.equal(calls, 1)
  assert.equal(model.provider, 'mikka.subscription')
})

test('a partial, failed or aborted stream cannot become a successful generation', async () => {
  const prefix: Part = { type: 'text-delta', id: 'partial', delta: 'Incomplete.' }
  for (const parts of [[prefix], [prefix, { type: 'error', error: new Error('provider-refusal') } as Part, finish]]) {
    await assert.rejects(Promise.resolve(streamingModel(fixture(parts)).doGenerate({ prompt: [] })), /subscription_generation_failed/)
  }
  const abort = new AbortController(); abort.abort()
  await assert.rejects(Promise.resolve(streamingModel(fixture([finish])).doGenerate({ prompt: [], abortSignal: abort.signal })), { name: 'AbortError' })
})

test('tool execution stays with eve and provider metadata and generation options survive the adapter', async () => {
  const tool: Part = { type: 'tool-call', toolCallId: 'call-1', toolName: 'read_issue', input: '{"id":"issue-1"}' }
  const options: Parameters<Model['doGenerate']>[0] = { prompt: [], maxOutputTokens: 32 }
  const result = await streamingModel(fixture([tool, finish], observed => assert.equal(observed, options))).doGenerate(options)
  assert.deepEqual(result.content, [tool])
  assert.deepEqual(result.usage, usage)
})

test('reasoning signatures survive metadata appended at the end of the block', async () => {
  const result = await streamingModel(fixture([
    { type: 'reasoning-start', id: 'r', providerMetadata: { anthropic: { signature: 'fixture-signature' } } },
    { type: 'reasoning-delta', id: 'r', delta: 'Consider the earlier turns.' },
    { type: 'reasoning-end', id: 'r', providerMetadata: { anthropic: { anotherField: true } } }, finish,
  ])).doGenerate({ prompt: [] })
  assert.deepEqual(result.content[0].providerMetadata, { anthropic: { signature: 'fixture-signature', anotherField: true } })
})
