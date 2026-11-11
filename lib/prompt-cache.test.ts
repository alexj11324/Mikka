import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { cacheableInstructions, promptOptions, withCacheBreakpoints, withCodexStablePrefix } from './prompt-cache'

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
  assert.deepEqual(promptOptions({ instructions: 'RULESmemory', stable: 5, messages: [] }), { messages: [], instructions: [{ role: 'system', content: 'RULES' }, { role: 'system', content: 'memory' }] }, '`stable` never reaches the model call as an option')
  assert.deepEqual(promptOptions({ prompt: 'synthetic' } as { prompt: string; instructions?: string }), { prompt: 'synthetic' })
})

test('rules and context have distinct nonempty cache boundaries without changing any prompt bytes', () => {
  const hint = { anthropic: { cacheControl: { type: 'ephemeral' } } }
  const text = '规则\n仓库和模型\n动态记忆'
  const rules = '规则'.length, stable = '规则\n仓库和模型'.length
  const instructions = cacheableInstructions(text, stable, rules)
  assert.deepEqual(instructions, [
    { role: 'system', content: '规则', providerOptions: hint },
    { role: 'system', content: '\n仓库和模型', providerOptions: hint },
    { role: 'system', content: '\n动态记忆' },
  ])
  assert.equal((instructions as { content: string }[]).map(message => message.content).join(''), text)
  assert.deepEqual(promptOptions({ instructions: text, stable, stableRules: rules, messages: [] }), { instructions, messages: [] })
  assert.deepEqual(promptOptions({ stable, stableRules: rules, messages: [] }), { messages: [] }, 'offsets never reach the model call')
  assert.deepEqual(cacheableInstructions('RULEScontext', 12, 5), [
    { role: 'system', content: 'RULES', providerOptions: hint },
    { role: 'system', content: 'context', providerOptions: hint },
  ], 'an absent dynamic tail does not drop the second stable breakpoint')
  assert.deepEqual(cacheableInstructions('RULEStail', 5, 5), [
    { role: 'system', content: 'RULES', providerOptions: hint }, { role: 'system', content: 'tail' },
  ], 'an absent repository context does not create an empty block')
  for (const invalid of [0, -1, 6, 1.5, Number.NaN]) {
    assert.deepEqual(cacheableInstructions('RULEStail', 5, invalid), cacheableInstructions('RULEStail', 5), 'invalid extra boundaries keep the legacy contract')
  }
  assert.equal(cacheableInstructions('', 0, 0), '')
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

test('the actual compatible serializer retains both stable layers and the final message marker', async () => {
  const system = cacheableInstructions('RULEScontexttail', 12, 5) as Exclude<ReturnType<typeof cacheableInstructions>, string>
  for (const last of [prompt[2], prompt[3], prompt[4]]) {
    let body: { messages: Record<string, unknown>[] } | undefined
    const model = createOpenAICompatible({ name: 'mikka-subscription', baseURL: 'https://mikka.invalid/v1', apiKey: 'placeholder', fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    } })('claude-haiku-5-5')
    const input = [...system, last] as Prompt
    const original = structuredClone(input)
    const result = await model.doStream({ prompt: withCacheBreakpoints(input, 'openaiCompatible') })
    await result.stream.pipeTo(new WritableStream())
    const cc = { type: 'ephemeral' }
    assert.deepEqual(body!.messages.map(message => [message.role, message.cache_control ?? null]), [
      ['system', cc], ['system', cc], ['system', null], [last.role, cc],
    ])
    // An assistant tool-call part also retains its metadata in this intermediate
    // format. The worker tests count actual Anthropic blocks after CPA conversion.
    assert.equal(body!.messages.filter(message => message.cache_control !== undefined).length, 3, 'three message-level markers')
    assert.deepEqual(input, original, 'the source prompt and its options stay untouched')
    const codex = await model.doStream({ prompt: input })
    await codex.stream.pipeTo(new WritableStream())
    assert.equal(JSON.stringify(body).includes('cache_control'), false, 'without the Claude route mapping, a compatible model receives no Anthropic hints')
  }
})

test('Codex moves only the prepared dynamic system tail after complete history, preserving every object', () => {
  const system = cacheableInstructions('RULEScontexttail', 12, 5) as Prompt
  const input: Prompt = [{ ...system[0], providerOptions: { ...system[0].providerOptions, openaiCompatible: { other: 1 } } }, ...system.slice(1), ...prompt.slice(2)]
  const saved = structuredClone(input)
  const moved = withCodexStablePrefix(input, 'gpt-6-luna')
  const expected = [input[0], input[1], ...input.slice(3), input[2]]
  assert.deepEqual(moved, expected)
  moved.forEach((message, index) => assert.equal(message, expected[index], 'roles, content, tool IDs and options retain their original objects'))
  assert.equal(moved.at(-1)?.role, 'system', 'Factory/Schedule instructions never become user data')
  assert.equal(moved[0].providerOptions?.openaiCompatible?.other, 1)
  assert.equal(JSON.stringify(moved).includes('mikka_cache_breakpoint'), false)
  assert.equal(JSON.stringify(moved).includes('prompt_cache_breakpoint'), false)
  assert.equal(withCodexStablePrefix(moved, 'gpt-6-luna'), moved, 'applying the layout twice is a no-op')
  assert.deepEqual(input, saved)
  const collapsed = [...cacheableInstructions('RULEStail', 5, 5) as Prompt, prompt[2]]
  assert.deepEqual(withCodexStablePrefix(collapsed, 'gpt-6-luna'), [collapsed[0], collapsed[2], collapsed[1]])
})

test('Codex layout gating leaves old and unknown models unchanged', () => {
  const hinted: Prompt = [...cacheableInstructions('RULEScontexttail', 12, 5) as Prompt, prompt[2]]
  for (const model of ['gpt-5.6', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra']) {
    assert.deepEqual(withCodexStablePrefix(hinted, model), [hinted[0], hinted[1], hinted[3], hinted[2]], model)
  }
  for (const model of ['gpt-5.5', 'gpt-5.4', 'gpt-5.6-unknown', 'gpt-6', 'gpt-6-unknown', 'gpt-6.2-sol', 'gpt-7-luna', 'openai/gpt-6-luna', 'claude-haiku-5-5', 'fixture-model']) {
    assert.equal(withCodexStablePrefix(hinted, model), hinted, model)
  }
})

test('Codex does not infer a dynamic tail from absent history, legacy or unknown system shapes', () => {
  const system = cacheableInstructions('RULEScontexttail', 12, 5) as Prompt
  const cases: Record<string, Prompt> = {
    empty: [],
    'no history': system,
    'no dynamic tail': [system[0], system[1], prompt[2]],
    'legacy unhinted': [...cacheableInstructions('RULEStail', 5) as Prompt, prompt[2]],
    'conversation first': [prompt[2], ...system],
    'three stable layers': [system[0], system[1], system[0], system[2], prompt[2]],
    'extra system': [...system, { role: 'system', content: 'another instruction' }, prompt[2]],
    'later system': [...system, prompt[2], { role: 'system', content: 'another instruction' }],
    'empty stable text': [{ ...system[0], content: '' } as Prompt[number], ...system.slice(1), prompt[2]],
    'empty tail': [system[0], system[1], { role: 'system', content: '' }, prompt[2]],
    'unknown hint': [{ ...system[0], providerOptions: { anthropic: { cacheControl: { type: 'unknown' } } } }, ...system.slice(1), prompt[2]],
    'unknown tail hint': [system[0], system[1], { ...system[2], providerOptions: { anthropic: { cacheControl: { type: 'unknown' } } } }, prompt[2]],
    'non-string tail': [system[0], system[1], { role: 'system', content: [{ type: 'text', text: 'tail' }] } as unknown as Prompt[number], prompt[2]],
    'unknown history role': [...system, { role: 'unknown', content: [] } as unknown as Prompt[number]],
  }
  for (const [name, input] of Object.entries(cases)) {
    const saved = structuredClone(input)
    assert.equal(withCodexStablePrefix(input, 'gpt-6-luna'), input, name)
    assert.deepEqual(input, saved, name)
  }
})
