import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamText, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { invalidateSubscriptionConnection } from '@mikka/protocol/subscription'
import { subscriptionFixture, SUBSCRIPTION_TEST_NOW as NOW } from '../tests/fixtures/subscription'
import { agentModelSourceSchema, resolveAgentModel } from './agent-model'
import { resolveSubscriptionModel } from './subscription-model'

const source = { type: 'subscription' as const, bindingId: '10000000-0000-4000-8000-000000000001' }
test('browser model selection accepts a binding reference, rejects credential and endpoint input', () => {
  assert.equal(agentModelSourceSchema.safeParse(source).success, true)
  assert.equal(agentModelSourceSchema.safeParse({ ...source, accessToken: 'synthetic-placeholder' }).success, false)
  assert.equal(agentModelSourceSchema.safeParse({ ...source, endpoint: 'https://untrusted.invalid' }).success, false)
})
function fakeModel() {
  return new MockLanguageModelV3({ doStream: async () => ({
    stream: simulateReadableStream({ chunks: [
      { type: 'text-start' as const, id: 'text' },
      { type: 'text-delta' as const, id: 'text', delta: 'subscription fixture' },
      { type: 'text-end' as const, id: 'text' },
      { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      } },
    ] }), warnings: [],
  }) })
}

for (const route of ['codex_cpa', 'claude_cpa', 'openai_siwc'] as const) test(`Mikka AI SDK loop streams two ${route} tasks through the same bound connection without login or paid fallback`, async () => {
  const { use, access } = subscriptionFixture(route)
  const fixture = fakeModel()
  let defaultCalls = 0
  let modelCalls = 0
  const backend = { access: async () => access, model: async () => { modelCalls++; return fixture } }
  for (let task = 0; task < 2; task++) {
    const model = await resolveAgentModel(source, {
      defaultModel: () => { defaultCalls++; throw new Error('paid fallback') },
      subscriptionModel: async bindingId => {
        assert.equal(bindingId, use.bindingId)
        return resolveSubscriptionModel(use, 'fixture-model', backend, () => NOW)
      },
    })
    assert.equal(await streamText({ model, prompt: 'Use synthetic subscription', maxRetries: 0 }).text, 'subscription fixture')
  }
  assert.equal(modelCalls, 2)
  assert.equal(fixture.doStreamCalls.length, 2)
  assert.equal(defaultCalls, 0)
})

test('explicit BYOS fails closed when production backend is unregistered', async () => {
  await assert.rejects(resolveAgentModel(source, { defaultModel: () => { throw new Error('paid fallback invoked') } }), { code: 'backend_unavailable' })
})

test('quota and cross-user refusals never construct a model or select a paid provider', async () => {
  for (const reason of ['quota_exhausted', 'quota_unknown', 'account_unavailable'] as const) {
    const { use, access } = subscriptionFixture('openai_siwc')
    if (reason === 'quota_exhausted') access.connection!.quota.windows[0].used = 1
    if (reason === 'quota_unknown') access.connection!.quota.status = 'unknown'
    if (reason === 'account_unavailable') access.connection!.ownerId = 'bob'
    await assert.rejects(resolveAgentModel(source, {
      defaultModel: () => { throw new Error('paid fallback invoked') },
      subscriptionModel: () => resolveSubscriptionModel(use, 'fixture', {
        access: async () => access, model: async () => { throw new Error('model constructed') },
      }, () => NOW),
    }), { code: reason })
  }
})

test('cached model rechecks binding on each AI SDK step after disconnect', async () => {
  const { use, access } = subscriptionFixture('openai_siwc')
  const fixture = fakeModel()
  const model = await resolveSubscriptionModel(use, 'fixture', { access: async () => access, model: async () => fixture }, () => NOW)
  access.connection = invalidateSubscriptionConnection(access.connection!, 'disconnected')
  await assert.rejects(async () => model.doStream({ prompt: [] }), { code: 'disconnected' })
  assert.equal(fixture.doStreamCalls.length, 0)
})

test('existing default provider remains explicit when no subscription was selected', async () => {
  const model = fakeModel()
  assert.equal(await resolveAgentModel(undefined, { defaultModel: () => model }), model)
})
