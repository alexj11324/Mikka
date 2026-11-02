import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { cacheableInstructions, promptOptions, withCacheBreakpoints } from './prompt-cache'

type Prompt = Parameters<typeof withCacheBreakpoints>[0]
const prompt: Prompt = [
  { role: 'system', content: 'rules and card catalog' },
  { role: 'system', content: '\n\nmemory, GitHub, computers online' },
  { role: 'user', content: [{ type: 'text', text: '派发任务，给 Mikka_test 写一个简单的 README' }] },
  { role: 'assistant', content: [{ type: 'text', text: '我先建一个任务。' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'create_issue', input: { title: 'README' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'create_issue', output: { type: 'json', value: { id: 'i1' } } }] },
]

test('the system prompt splits where its stable prefix ends, and stays one string otherwise', () => {
  assert.deepEqual(cacheableInstructions('RULESmemory', 5), [{ role: 'system', content: 'RULES' }, { role: 'system', content: 'memory' }])
  for (const stable of [undefined, 0, 11, 20]) assert.equal(cacheableInstructions('RULESmemory', stable), 'RULESmemory')
  assert.deepEqual(promptOptions({ instructions: 'RULESmemory', stable: 5, messages: [] }), { messages: [], instructions: [{ role: 'system', content: 'RULES' }, { role: 'system', content: 'memory' }] }, '`stable` never reaches WorkflowAgent as an option')
  assert.deepEqual(promptOptions({ prompt: 'synthetic' } as { prompt: string; instructions?: string }), { prompt: 'synthetic' })
})

test('breakpoints go on the first system message and on the last message and its last part, keeping other options', () => {
  const marked = withCacheBreakpoints([{ ...prompt[0], providerOptions: { openaiCompatible: { other: 1 } } }, ...prompt.slice(1)], 'openaiCompatible')
  const cc = { type: 'ephemeral' }
  assert.deepEqual(marked[0].providerOptions, { openaiCompatible: { other: 1, cache_control: cc } })
  assert.equal(marked[1].providerOptions, undefined, 'the changing system tail is after the breakpoint')
  assert.equal(marked[2].providerOptions, undefined)
  assert.equal(marked[3].providerOptions, undefined)
  assert.deepEqual(marked[4].providerOptions, { openaiCompatible: { cache_control: cc } })
  assert.deepEqual((marked[4].content as { providerOptions?: unknown }[])[0].providerOptions, { openaiCompatible: { cache_control: cc } })
  assert.deepEqual(withCacheBreakpoints(prompt, 'anthropic')[0].providerOptions, { anthropic: { cacheControl: cc } })
  assert.equal(prompt[0].providerOptions, undefined, 'the caller\'s prompt is not changed')
})

test('the OpenAI-compatible request the Claude subscription broker receives carries cache_control on the stable system message and the last message', async () => {
  let body: { messages: Record<string, unknown>[] } | undefined
  const model = createOpenAICompatible({ name: 'mikka-subscription', baseURL: 'https://mikka.invalid/v1', apiKey: 'placeholder', fetch: async (_url, init) => {
    body = JSON.parse(String(init?.body))
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })('claude-haiku-5-5')
  const result = await model.doStream({ prompt: withCacheBreakpoints(prompt, 'openaiCompatible') })
  await result.stream.pipeTo(new WritableStream())
  const cc = { type: 'ephemeral' }
  assert.deepEqual(body!.messages.map(message => [message.role, message.cache_control ?? null]), [
    ['system', cc], ['system', null], ['user', null], ['assistant', null], ['tool', cc],
  ])
})
