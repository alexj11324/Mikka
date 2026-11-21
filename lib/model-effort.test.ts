// A Bot's saved reasoning effort reaches every chat model call (lib/model-effort.ts).
import assert from 'node:assert/strict'
import test from 'node:test'
import { withModelEffort } from './model-effort'

type Model = Parameters<typeof withModelEffort>[0]
function recorder(modelId: string) {
  const calls: unknown[] = []
  const model = {
    specificationVersion: 'v4', provider: 'test', modelId, supportedUrls: {},
    doStream: async (options: { providerOptions?: unknown }) => { calls.push(options.providerOptions); return { stream: new ReadableStream() } },
    doGenerate: async (options: { providerOptions?: unknown }) => { calls.push(options.providerOptions); return {} },
  } as unknown as Model
  return { model, calls }
}

test('a supported effort is added to each call; the call\'s own options win', async () => {
  const { model, calls } = recorder('claude-haiku-5-5')
  const wrapped = withModelEffort(model, 'high')
  await wrapped.doStream({ prompt: [], providerOptions: { anthropic: { effort: 'low', cacheControl: true } } } as never)
  await wrapped.doGenerate({ prompt: [] } as never)
  assert.deepEqual(calls[0], { openai: { reasoningEffort: 'high' }, openaiCompatible: { reasoningEffort: 'high' }, anthropic: { effort: 'low', cacheControl: true } })
  assert.deepEqual((calls[1] as { anthropic: unknown }).anthropic, { effort: 'high' })
  const codex = recorder('openai/gpt-6-luna')
  await withModelEffort(codex.model, 'xhigh').doStream({ prompt: [] } as never)
  assert.deepEqual((codex.calls[0] as { openai: unknown }).openai, { reasoningEffort: 'xhigh' })
})

test('no effort, or one the model does not list, leaves the model as it is', () => {
  const { model } = recorder('claude-haiku-5-5')
  assert.equal(withModelEffort(model, null), model)
  assert.equal(withModelEffort(model, undefined), model)
  assert.equal(withModelEffort(recorder('gpt-5.5').model, 'max').modelId, 'gpt-5.5')
  const gpt55 = recorder('gpt-5.5').model
  assert.equal(withModelEffort(gpt55, 'max'), gpt55, 'gpt-5.5 has no max effort')
  const unknown = recorder('some-new-model').model
  assert.equal(withModelEffort(unknown, 'low'), unknown)
})
