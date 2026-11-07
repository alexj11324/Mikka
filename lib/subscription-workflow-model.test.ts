import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { SubscriptionWorkflowModel } from './subscription-workflow-model'
import { cacheableInstructions } from './prompt-cache'
const calls: {selection: unknown; signal: unknown; options?: unknown}[] = []
const streamResult = {stream: new ReadableStream({start(controller) {controller.close()}})}
mock.module(new URL('./subscription-workflow-model-runtime.ts', import.meta.url).href, {namedExports: {
  resolveSubscriptionWorkflowModel: async (selection: unknown, signal: unknown) => {
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

test('the Codex subscription SDK request preserves only prepared stable-system cache hints', async () => {
  const system = cacheableInstructions('RULEScontexttail', 12, 5) as Exclude<ReturnType<typeof cacheableInstructions>, string>
  const prompt = [...system, { role: 'user' as const, content: [{ type: 'text' as const, text: 'fixture-request' }] }]
  const saved = structuredClone(prompt)
  const options = { prompt, abortSignal: new AbortController().signal }
  const turn = await new SubscriptionWorkflowModel({ ...selection, modelId: 'gpt-6-luna', route: 'codex_cpa' }).doStream(options)
  await turn.stream.pipeTo(new WritableStream())
  const forwarded = calls.at(-1)!.options as typeof options
  let body: { messages: Record<string, unknown>[] } | undefined
  const model = createOpenAICompatible({ name: 'mikka-subscription', baseURL: 'https://mikka.invalid/v1', apiKey: 'placeholder', fetch: async (_url, init) => {
    body = JSON.parse(String(init?.body))
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })('gpt-6-luna')
  const result = await model.doStream(forwarded)
  await result.stream.pipeTo(new WritableStream())
  assert.deepEqual(body!.messages.map(message => message.mikka_cache_breakpoint ?? null), ['stable_system_v1', 'stable_system_v1', null, null], 'codex_stable_cache_hints_missing')
  assert.deepEqual(body!.messages.map(message => message.content), ['RULES', 'context', 'tail', 'fixture-request'])
  assert.equal('prompt_cache_options' in body!, false, 'implicit caching remains the default')
  assert.equal('prompt_cache_key' in body!, false)
  assert.equal(forwarded.abortSignal, options.abortSignal)
  assert.deepEqual(prompt, saved)
})

test('only the supported Codex CPA route maps prepared stable-system hints', async () => {
  const prompt = cacheableInstructions('RULEScontexttail', 12, 5) as Exclude<ReturnType<typeof cacheableInstructions>, string>
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
})
