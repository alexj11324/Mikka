import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MockLanguageModelV3 } from 'ai/test'
import type { SubscriptionService } from './subscription-service'
import { resolveAgentExecutionModel } from './agent-execution-model'

const source = { type: 'subscription', bindingId: '10000000-0000-4000-8000-000000000001' }
function fixture() {
  const model = new MockLanguageModelV3()
  const calls: unknown[] = []
  const binding = async (ownerId: string, bindingId: string) => {
    calls.push(['binding', ownerId, bindingId])
    return { workspaceId: 'bound-workspace' }
  }
  const service = {
    repository: { binding },
    model: async (use: unknown, signal?: AbortSignal) => { calls.push(['model', use, signal]); return model },
  }
  const dependencies = {
    defaultModel: () => { calls.push('default'); return model },
    subscriptionService: () => { calls.push('service'); return service as unknown as SubscriptionService },
    workspace: async (owner: string, workspace: string) => { calls.push(['workspace', owner, workspace]) },
  }
  return { model, calls, dependencies, service }
}
test('absent selection resolves the default without creating any subscription backend', async () => {
  const f = fixture()
  assert.equal(await resolveAgentExecutionModel({ ownerId: 'alice', consumerId: 'bot' }, f.dependencies), f.model)
  assert.deepEqual(f.calls, ['default'])
})
test('explicit subscription carries authenticated actor, bound workspace and cancellation into the existing service', async () => {
  const f = fixture(), signal = new AbortController().signal
  assert.equal(await resolveAgentExecutionModel({ ownerId: 'alice', consumerId: 'bot', source, signal }, f.dependencies), f.model)
  assert.deepEqual(f.calls, ['service', ['binding', 'alice', source.bindingId], ['workspace', 'alice', 'bound-workspace'],
    ['model', { ownerId: 'alice', consumerId: 'bot', bindingId: source.bindingId, workspaceId: 'bound-workspace', execution: 'model' }, signal]])
})
test('malformed explicit selection never silently chooses default or accepts actor/credential overrides', async () => {
  for (const input of [null, {}, { ...source, ownerId: 'other' }, { ...source, accessToken: 'synthetic' }, { ...source, bindingId: 'invalid' }]) {
    const f = fixture()
    await assert.rejects(resolveAgentExecutionModel({ ownerId: 'alice', consumerId: 'bot', source: input }, f.dependencies), { code: 'binding_mismatch' })
    assert.deepEqual(f.calls, [])
  }
})
test('lookup and workspace refusals never call default or construct a model', async () => {
  for (const stage of ['binding', 'workspace'] as const) {
    const f = fixture()
    if (stage === 'binding') f.service.repository.binding = async () => { throw new Error('denied') }
    else f.dependencies.workspace = async () => { throw new Error('denied') }
    await assert.rejects(resolveAgentExecutionModel({ ownerId: 'alice', consumerId: 'bot', source }, f.dependencies), /denied/)
    assert.ok(!f.calls.includes('default'))
    assert.ok(!f.calls.some(call => Array.isArray(call) && call[0] === 'model'))
  }
})
test('pre-cancelled selection performs no default or subscription work', async () => {
  for (const selection of [undefined, source]) {
    const f = fixture(), controller = new AbortController()
    controller.abort('private cancellation reason')
    await assert.rejects(resolveAgentExecutionModel({ ownerId: 'alice', consumerId: 'bot', source: selection, signal: controller.signal }, f.dependencies), { name: 'AbortError', message: 'Model resolution cancelled' })
    assert.deepEqual(f.calls, [])
  }
})
test('cancellation during binding or workspace checks cannot construct a model afterward', async () => {
  for (const stage of ['binding', 'workspace'] as const) {
    const f = fixture(), controller = new AbortController()
    if (stage === 'binding') f.service.repository.binding = async () => { controller.abort(); return { workspaceId: 'bound-workspace' } }
    else f.dependencies.workspace = async () => { controller.abort() }
    await assert.rejects(resolveAgentExecutionModel({ ownerId: 'alice', consumerId: 'bot', source, signal: controller.signal }, f.dependencies), { name: 'AbortError' })
    assert.ok(!f.calls.includes('default'))
    assert.ok(!f.calls.some(call => Array.isArray(call) && call[0] === 'model'))
  }
})
test('cancellation during model resolution discards the result without fallback', async () => {
  const f = fixture(), controller = new AbortController()
  f.service.model = async (_use, signal) => {
    assert.equal(signal, controller.signal)
    controller.abort()
    return f.model
  }
  await assert.rejects(resolveAgentExecutionModel({ ownerId: 'alice', consumerId: 'bot', source, signal: controller.signal }, f.dependencies), { name: 'AbortError' })
  assert.ok(!f.calls.includes('default'))
})
