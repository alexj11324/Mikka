import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import type { DynamicModelContext } from 'eve'
import type { EveScope } from './scope'

const scope: EveScope = {
  ownerId: 'fixture-owner', botId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002', surface: 'web',
}
let prepareCalls = 0, sourceReads = 0, scopeChecks = 0, leaseChecks = 0
let prepareFails = false, sourceFails = false, scopeDenied = false, leaseDenied = false

mock.module(new URL('./scope.ts', import.meta.url).href, { namedExports: {
  scopeFromAuth: (auth: { attributes: EveScope }) => auth.attributes,
  async assertEveScope(value: EveScope) {
    scopeChecks++
    if (scopeDenied) throw new Error('workspaceAccessDenied')
    return value
  },
} })
mock.module(new URL('./product-rpc.ts', import.meta.url).href, { namedExports: {
  productRpc: async () => { throw new Error('unexpected product operation') },
} })
mock.module(new URL('./product-gateway.ts', import.meta.url).href, { namedExports: {
  async prepareEveExecution() {
    prepareCalls++
    if (prepareFails) throw new Error('preparation unavailable')
    return { execution: null, runtime: { harness: 'ai_sdk', model: 'frozen-model-' + prepareCalls } }
  },
} })
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {
  async query() {
    sourceReads++
    if (sourceFails) throw new Error('source unavailable')
    return { rows: [{ source_event_id: 'fixture-source' }] }
  },
} } })
mock.module(new URL('./scheduled-read.ts', import.meta.url).href, { namedExports: {
  async loadScheduledRead() {
    leaseChecks++
    if (leaseDenied) throw new Error('scheduleReadAuthorityLost')
    return { occurrenceId: 'fixture-occurrence', leaseToken: 'fixture-lease', allowedActions: [], prompt: 'read only' }
  },
} })
mock.module(new URL('./evaluation-runtime.ts', import.meta.url).href, { namedExports: {
  evaluationForSession: async () => null, evaluationModel: () => null,
} })
mock.module(new URL('../abuse/workflow-model.ts', import.meta.url).href, { namedExports: { HostedWorkflowModel: class {} } })
mock.module(new URL('../subscription-workflow-model.ts', import.meta.url).href, { namedExports: { SubscriptionWorkflowModel: class {} } })

// Use Eve's real session-local state container. Product dependencies stay inert.
const { ContextContainer, contextStorage } = await import(new URL('./context/container.js', import.meta.resolve('eve')).href)
const { executionForSession, modelForSession } = await import('./runtime')

function definitionContext({ sessionId = 'fixture-session', turnId = 'turn_1', currentScope = scope,
  memos = new Map<string, unknown>() } = {}): DynamicModelContext {
  return {
    session: { id: sessionId, auth: { current: { attributes: currentScope } } },
    turn: { id: turnId },
    async memo(key: unknown, work: () => Promise<unknown>) {
      const encoded = JSON.stringify(key)
      if (!memos.has(encoded)) memos.set(encoded, structuredClone(await work()))
      return structuredClone(memos.get(encoded))
    },
  } as unknown as DynamicModelContext
}

beforeEach(() => {
  prepareCalls = sourceReads = scopeChecks = leaseChecks = 0
  prepareFails = sourceFails = scopeDenied = leaseDenied = false
})

test('distinct dynamic definition memos share one preparation without repeated scope reads', async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const results = []
    for (let definition = 0; definition < 5; definition++) {
      results.push(await executionForSession(definitionContext()))
    }
    assert.equal(prepareCalls, 1)
    assert.equal(sourceReads, 1)
    assert.equal(scopeChecks, 0)
    assert.equal(leaseChecks, 5)
    assert.ok(results.every(result => result.runtime.model === 'frozen-model-1'))
    results[0].runtime.model = 'changed by one consumer'
    assert.equal((await executionForSession(definitionContext())).runtime.model, 'frozen-model-1')
  })
})

test('native durable state survives a new context with new definition memos and stays session isolated', async () => {
  const original = new ContextContainer()
  await contextStorage.run(original, () => executionForSession(definitionContext()))
  const restored = new ContextContainer()
  for (const [key, value] of original.entries()) restored.set(key, structuredClone(value))
  await contextStorage.run(restored, () => executionForSession(definitionContext()))
  assert.equal(prepareCalls, 1)
  assert.equal(scopeChecks, 0)
  assert.equal(leaseChecks, 2)
  await contextStorage.run(new ContextContainer(), () => executionForSession(definitionContext()))
  assert.equal(prepareCalls, 2)
})

test('a new session, turn or exact scope cannot reuse another preparation even within one definition', async () => {
  const changes = [
    { sessionId: 'other-session' }, { turnId: 'turn_2' },
    ...Object.entries({ ownerId: 'other-owner', botId: '00000000-0000-4000-8000-000000000003',
      workspaceId: '00000000-0000-4000-8000-000000000004', surface: 'slack' })
      .map(([key, value]) => ({ currentScope: { ...scope, [key]: value } as EveScope })),
  ]
  for (const change of changes) {
    const before = prepareCalls
    const memos = new Map<string, unknown>()
    await contextStorage.run(new ContextContainer(), async () => {
      await executionForSession(definitionContext({ memos }))
      const next = await executionForSession(definitionContext({ ...change, memos }))
      assert.equal(next.runtime.model, 'frozen-model-' + (before + 2))
    })
    assert.equal(prepareCalls, before + 2)
  }
})

test('each native model evaluation checks current scope and scheduled-read authority before reusing preparation', async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    await modelForSession(definitionContext())
    scopeDenied = true
    await assert.rejects(modelForSession(definitionContext()), /workspaceAccessDenied/)
    assert.equal(leaseChecks, 1)
    scopeDenied = false
    leaseDenied = true
    await assert.rejects(modelForSession(definitionContext()), /scheduleReadAuthorityLost/)
    leaseDenied = false
    await modelForSession(definitionContext())
    assert.equal(prepareCalls, 1)
    assert.equal(scopeChecks, 4)
    assert.equal(leaseChecks, 3)
  })
})

test('preparation or source failures leave reuse retryable and preserve a completed durable memo', async () => {
  const memos = new Map<string, unknown>()
  await contextStorage.run(new ContextContainer(), async () => {
    prepareFails = true
    await assert.rejects(executionForSession(definitionContext({ memos })), /preparation unavailable/)
    prepareFails = false
    sourceFails = true
    await assert.rejects(executionForSession(definitionContext({ memos })), /source unavailable/)
    sourceFails = false
    await executionForSession(definitionContext({ memos }))
    await executionForSession(definitionContext())
    assert.equal(prepareCalls, 2)
    assert.equal(sourceReads, 2)
    assert.equal(leaseChecks, 2)
  })
})
