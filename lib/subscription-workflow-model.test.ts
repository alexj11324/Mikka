import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { SubscriptionWorkflowModel } from './subscription-workflow-model'
import { cacheableInstructions, withCacheBreakpoints } from './prompt-cache'
const calls: {selection: unknown; signal: unknown; options?: unknown}[] = []
let resolverObservation: (() => Promise<void>) | undefined
const streamResult = {stream: new ReadableStream({start(controller) {controller.close()}})}
mock.module(new URL('./subscription-workflow-model-runtime.ts', import.meta.url).href, {namedExports: {
  resolveSubscriptionWorkflowModel: async (selection: unknown, signal: unknown) => {
    await resolverObservation?.()
    const call = {selection, signal, options: undefined as unknown}; calls.push(call)
    return {specificationVersion: 'v4', doStream: async (options: unknown) => {call.options = options; return {...streamResult, stream: new ReadableStream({start(controller) {controller.close()}})}}}
  },
}})
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const selection={type:'subscription' as const,bindingId:id(3),ownerId:'alice',consumerId:id(1),workspaceId:id(2),connectionId:id(4),connectionRevision:7,modelId:'saved-model',route:'claude_cpa' as const}
test('Workflow serde carries only the fixed non-secret binding descriptor',()=>{
  const first=new SubscriptionWorkflowModel(selection)
  const serialized=SubscriptionWorkflowModel[WORKFLOW_SERIALIZE](first)
  assert.deepEqual(serialized,selection)
  const restored=SubscriptionWorkflowModel[WORKFLOW_DESERIALIZE](JSON.parse(JSON.stringify(serialized)))
  assert.equal(restored.modelId,'saved-model')
  assert.deepEqual(SubscriptionWorkflowModel[WORKFLOW_SERIALIZE](restored),selection)
  assert.throws(()=>SubscriptionWorkflowModel[WORKFLOW_DESERIALIZE]({...selection,accessToken:'synthetic-canary'}))
})
test('unsupported non-streaming invocation refuses rather than calling a default provider',async()=>{
  await assert.rejects(new SubscriptionWorkflowModel(selection).doGenerate({prompt:[]}),/subscription_stream_required/)
})

test('the Node model method resolves the fixed descriptor and forwards cancellation into the existing stream call', async () => {
  const controller = new AbortController(), options = {prompt: [], abortSignal: controller.signal}
  // The provider's result comes back with its stream timed (lib/model-call-timing.ts), its parts unchanged.
  const result = await new SubscriptionWorkflowModel(selection).doStream(options)
  assert.deepEqual(Object.keys(result), Object.keys(streamResult))
  assert.deepEqual(await Array.fromAsync(result.stream as unknown as AsyncIterable<unknown>), [])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].selection, selection)
  assert.equal(calls[0].signal, controller.signal)
  // A Claude subscription gets the same request with cache breakpoints added (lib/prompt-cache.ts); nothing else changes.
  assert.deepEqual(calls[0].options, { ...options, prompt: [] })
  assert.equal((calls[0].options as { abortSignal: unknown }).abortSignal, controller.signal)
})

test('the same model marks Claude cache breakpoints and leaves a Codex request as it is', async () => {
  const prompt = [{ role: 'system' as const, content: 'rules' }, { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }]
  await new SubscriptionWorkflowModel(selection).doStream({ prompt })
  const claude = (calls.at(-1)!.options as { prompt: { providerOptions?: unknown }[] }).prompt
  assert.deepEqual(claude.map(message => message.providerOptions), [{ openaiCompatible: { cache_control: { type: 'ephemeral' } } }, { openaiCompatible: { cache_control: { type: 'ephemeral' } } }])
  const codexOptions = { prompt }
  await new SubscriptionWorkflowModel({ ...selection, route: 'codex_cpa' }).doStream(codexOptions)
  assert.equal(calls.at(-1)!.options, codexOptions)
})

type StreamOptions = Parameters<SubscriptionWorkflowModel['doStream']>[0]
async function compatibleWire(options: StreamOptions) {
  let body: { messages: Record<string, unknown>[]; [key: string]: unknown } | undefined
  let requests = 0
  const model = createOpenAICompatible({ name: 'mikka-subscription', baseURL: 'https://mikka.invalid/v1', apiKey: 'placeholder', fetch: async (_url, init) => {
    requests++
    body = JSON.parse(String(init?.body))
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })('gpt-6-luna')
  const result = await model.doStream(options)
  await result.stream.pipeTo(new WritableStream())
  assert.equal(requests, 1, 'one serialization/transport attempt, without fallback')
  assert.ok(body)
  return body
}

test('the Codex subscription SDK request keeps the dynamic system tail after history without cache fields', async () => {
  const system = cacheableInstructions('RULEScontexttail', 12, 5) as StreamOptions['prompt']
  const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'fixture-request' }] }
  const assistant = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'fixture-reply 🦊' }] }
  const tools: StreamOptions['prompt'] = [
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'fixture-call-1', toolName: 'fixture_lookup', input: { key: 'one' } },
      { type: 'tool-call', toolCallId: 'fixture-call-2', toolName: 'fixture_lookup', input: { key: 'two' } },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'fixture-call-1', toolName: 'fixture_lookup', output: { type: 'json', value: { value: 'one' } } },
      { type: 'tool-result', toolCallId: 'fixture-call-2', toolName: 'fixture_lookup', output: { type: 'text', value: 'two' } },
    ] },
  ]
  for (const history of [[user], [user, assistant, user], [user, assistant], [user, ...tools], [user, ...tools, assistant]]) {
    const prompt = [...system, ...history]
    const saved = structuredClone(prompt)
    const options: StreamOptions = { prompt, abortSignal: new AbortController().signal, tools: [
      { type: 'function', name: 'fixture_lookup', description: 'Read one fixture', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } },
      { type: 'function', name: 'fixture_second', description: 'Read another fixture', inputSchema: { type: 'object', properties: {} } },
    ] }
    const before = await compatibleWire(options)
    const priorCalls = calls.length
    const turn = await new SubscriptionWorkflowModel({ ...selection, modelId: 'gpt-6-luna', route: 'codex_cpa' }).doStream(options)
    await turn.stream.pipeTo(new WritableStream())
    assert.equal(calls.length, priorCalls + 1, 'the frozen model is resolved once per call')
    const forwarded = calls.at(-1)!.options as typeof options
    const body = await compatibleWire(forwarded)
    assert.deepEqual(body.messages, [...before.messages.slice(0, 2), ...before.messages.slice(3), before.messages[2]], 'codex_dynamic_tail_still_in_initial_system_prefix')
    assert.deepEqual({ ...body, messages: [] }, { ...before, messages: [] }, 'no model, tool, cache, session or TTL options change')
    assert.equal(body.messages.at(-1)?.role, 'system')
    assert.equal(body.messages.at(-1)?.content, 'tail')
    assert.equal(JSON.stringify(body).includes('mikka_cache_breakpoint'), false)
    assert.equal(JSON.stringify(body).includes('prompt_cache_breakpoint'), false)
    assert.equal('prompt_cache_options' in body, false, 'implicit caching remains the default')
    assert.equal('prompt_cache_key' in body, false)
    assert.equal(forwarded.abortSignal, options.abortSignal)
    assert.deepEqual(calls.at(-1)!.selection, { ...selection, modelId: 'gpt-6-luna', route: 'codex_cpa' })
    assert.deepEqual(prompt, saved)
  }
})

test('only the supported Codex CPA route moves the prepared tail; Claude, API-key and native paths keep their contracts', async () => {
  const prompt: StreamOptions['prompt'] = [...cacheableInstructions('RULEScontexttail', 12, 5) as StreamOptions['prompt'], { role: 'user', content: [{ type: 'text', text: 'fixture-request' }] }]
  for (const frozen of [
    { ...selection, modelId: 'gpt-6-luna', route: 'openai_siwc' as const },
    { ...selection, modelId: 'gpt-5.5', route: 'codex_cpa' as const },
    { ...selection, modelId: 'gpt-6-unknown', route: 'codex_cpa' as const },
  ]) {
    const options = { prompt }
    const result = await new SubscriptionWorkflowModel(frozen).doStream(options)
    await result.stream.pipeTo(new WritableStream())
    assert.equal(calls.at(-1)!.options, options)
  }
  for (const [frozen, key] of [
    [selection, 'openaiCompatible'],
    [{ type: 'api_key', keyId: id(5), ownerId: selection.ownerId, consumerId: selection.consumerId, workspaceId: selection.workspaceId, modelId: 'claude-haiku-5-5' }, 'anthropic'],
  ] as const) {
    const result = await new SubscriptionWorkflowModel(frozen).doStream({ prompt })
    await result.stream.pipeTo(new WritableStream())
    assert.deepEqual(calls.at(-1)!.options, { prompt: withCacheBreakpoints(prompt, key) })
  }
})

test('timing reports whether the actual Codex layout was applied without changing other routes or unknown shapes', async t => {
  const logs: { codexLayoutApplied?: boolean }[] = []
  t.mock.method(console, 'info', (line: string) => { logs.push(JSON.parse(line)) })
  const supported: StreamOptions['prompt'] = [...cacheableInstructions('RULEScontexttail', 12, 5) as StreamOptions['prompt'], { role: 'user', content: [{ type: 'text', text: 'fixture' }] }]
  const cases = [
    { frozen: { ...selection, modelId: 'gpt-6-luna', route: 'codex_cpa' as const }, prompt: supported, expected: true },
    { frozen: { ...selection, modelId: 'gpt-6-luna', route: 'codex_cpa' as const }, prompt: [{ role: 'system' as const, content: 'legacy' }, supported.at(-1)!], expected: false },
    { frozen: { ...selection, modelId: 'gpt-6-unknown', route: 'codex_cpa' as const }, prompt: supported, expected: false },
    { frozen: { ...selection, modelId: 'gpt-6-luna', route: 'openai_siwc' as const }, prompt: supported, expected: undefined },
    { frozen: selection, prompt: supported, expected: undefined },
  ]
  for (const sample of cases) {
    const result = await new SubscriptionWorkflowModel(sample.frozen).doStream({ prompt: sample.prompt })
    await result.stream.pipeTo(new WritableStream())
    const line = logs.at(-1)!
    assert.equal(line.codexLayoutApplied, sample.expected, 'actual_codex_layout_not_reported')
    assert.equal(Object.hasOwn(line, 'codexLayoutApplied'), sample.expected !== undefined)
  }
})

test('setup quota workers are observed before the provider request without logging their inputs', async t => {
  const { currentSubscriptionTiming } = await import('../packages/daemon/src/subscription-worker-timing')
  const logs: { setupMs: number; subscriptionStages: { workers: { method: string }[] } }[] = []
  t.mock.method(console, 'info', (line: string) => { logs.push(JSON.parse(line)) })
  resolverObservation = async () => {
    await Promise.resolve()
    for (const method of ['prepare', 'quota']) {
      const worker = currentSubscriptionTiming()?.startWorker(method)
      worker?.beginIdentity()()
      worker?.configWrite()
      worker?.settle('result')
    }
  }
  try {
    const result = await new SubscriptionWorkflowModel(selection).doStream({ prompt: [] })
    await result.stream.pipeTo(new WritableStream())
    assert.equal(logs.length, 1)
    assert.deepEqual(logs[0].subscriptionStages.workers.map(worker => worker.method), ['prepare', 'quota'])
    assert.ok(logs[0].setupMs >= 0)
    assert.equal(JSON.stringify(logs).includes(selection.bindingId), false)
    assert.equal(JSON.stringify(logs).includes(selection.ownerId), false)
  } finally { resolverObservation = undefined }
})
