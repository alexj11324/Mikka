import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde'
import { ApiKeyWorkflowModel } from './api-key-workflow-model'

const calls: { selection: unknown; signal: unknown; options?: unknown }[] = []
const streamResult = { stream: new ReadableStream({ start(controller) { controller.close() } }) }
mock.module(new URL('./api-key-workflow-model-runtime.ts', import.meta.url).href, { exports: {
  resolveApiKeyWorkflowModel: async (selection: unknown, signal: unknown) => {
    const call = { selection, signal, options: undefined as unknown }; calls.push(call)
    return { specificationVersion: 'v4', doStream: async (options: unknown) => { call.options = options; return streamResult } }
  },
} })

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const selection = { type: 'apiKey' as const, coordinator: true as const, ownerId: 'alice', consumerId: id(1), workspaceId: id(2), connectionId: id(3), bindingId: id(4), modelId: 'deepseek-chat' }

test('Workflow serde carries only the non-secret API-key reference', () => {
  const first = new ApiKeyWorkflowModel(selection)
  const serialized = ApiKeyWorkflowModel[WORKFLOW_SERIALIZE](first)
  assert.deepEqual(serialized, selection)
  const restored = ApiKeyWorkflowModel[WORKFLOW_DESERIALIZE](JSON.parse(JSON.stringify(serialized)))
  assert.equal(restored.modelId, 'deepseek-chat')
  // An unknown field (a smuggled key) is rejected by the strict schema.
  assert.throws(() => ApiKeyWorkflowModel[WORKFLOW_DESERIALIZE]({ ...selection, apiKey: 'synthetic-canary' }))
})

test('the Node model step resolves the reference and forwards cancellation into the stream call', async () => {
  const controller = new AbortController(), options = { prompt: [], abortSignal: controller.signal }
  assert.equal(await new ApiKeyWorkflowModel(selection).doStream(options), streamResult)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].selection, selection)
  assert.equal(calls[0].signal, controller.signal)
  assert.equal(calls[0].options, options)
})
