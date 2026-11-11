import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { streamText, type ToolSet } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { makeSnapshot } from '../agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'
import type { AgentExecution } from '../agent-kit/store'
import type { NativeToolScope } from '../../workflows/coordinator/tool-scope'
import { fakeWorkflowRuntime } from '../../tests/support/fake-workflow'

const owner = 'synthetic-tool-owner', bot = '10000000-0000-4000-8000-000000000001'
const input = { query: 'Synthetic offline search' }
const answer = { ok: true, results: [] }
const calls: unknown[][] = []
const webSearchStep = async (...args: unknown[]) => { calls.push(args); return answer }
const beforeCall = mock.fn(async () => {})
const afterCall = mock.fn(async () => {})
const fake = fakeWorkflowRuntime()
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
mock.module('workflow', { namedExports: fake.exports })
stub('../../workflows/coordinator/steps.ts', { webSearchStep })
stub('../../workflows/coordinator/agent-kit-steps.ts', { beforeAgentTool: beforeCall, afterAgentTool: afterCall, loadAgentSkill: async () => ({ error: 'notAssigned' }) })
stub('../composio-actions.ts', { createComposioAITools: () => ({}), createGoogleAITools: () => ({}) })


let registry: typeof import('../../workflows/coordinator/tools')
before(async () => { registry = await import('../../workflows/coordinator/tools') })
beforeEach(() => { calls.length = 0; for (const fn of [beforeCall, afterCall]) fn.mock.resetCalls() })
const execution: AgentExecution = {
  id: '10000000-0000-4000-8000-000000000002', status: 'running',
  snapshot: makeSnapshot('10000000-0000-4000-8000-000000000003', 1, { ...DEFAULT_AGENT_DEFINITION, tools: ['web_search'] }, 'Synthetic host', { harness: 'ai_sdk', model: 'synthetic' }),
}
const createTools = (scope?: NativeToolScope): ToolSet => registry.coordinatorTools(owner, bot, scope, {
  execution, switches: { issueTools: false, factoryRouting: false, factoryLifecycle: false },
})

test('actual SDK streaming passes its call id through the instrumented Coordinator search registry', async t => {
  let modelCalls = 0
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External transport forbidden in this offline SDK fixture') })
  const model = new MockLanguageModelV4({ doStream: async () => {
    modelCalls++
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
      controller.enqueue({ type: 'tool-call', toolCallId: 'sdk-call', toolName: 'web_search', input: JSON.stringify(input) })
      controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } })
      controller.close()
    } }) }
  } })
  const result = streamText({ model, tools: createTools(), prompt: 'Synthetic offline request', maxRetries: 0 })
  for await (const part of result.fullStream) if (part.type === 'error') throw part.error
  assert.deepEqual(calls, [[owner, input, undefined, 'sdk-call']])
  assert.equal(modelCalls, 1)
  assert.equal(beforeCall.mock.callCount(), 1); assert.equal(afterCall.mock.callCount(), 1)
  assert.equal((await result.toolResults)[0]?.toolCallId, 'sdk-call')
})
