import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { createRequire } from 'node:module'
import type { DynamicModelContext } from 'eve'
import type { EveScope } from './scope'

const scope: EveScope = {
  ownerId: 'fixture-owner', botId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002', surface: 'web',
}
let prepareCalls = 0, sourceReads = 0, scopeChecks = 0, leaseChecks = 0
let prepareFails = false, sourceFails = false, scopeDenied = false, leaseDenied = false
let sessionChecks = 0, factoryReads = 0, factoryEnabled = true, factoryPending = false, factoryFails = false, scheduled = false
const instructionCalls: unknown[] = [], rpcCalls: unknown[] = []
let principal: EveScope | null = null

mock.module(new URL('./scope.ts', import.meta.url).href, { namedExports: {
  scopeFromAuth: (auth: { attributes: EveScope }) => auth.attributes,
  async assertEveScope(value: EveScope) {
    scopeChecks++
    if (scopeDenied) throw new Error('workspaceAccessDenied')
    return value
  },
  async assertSessionScope(value: EveScope, sessionId: string) {
    sessionChecks++
    assert.equal(sessionId, 'fixture-session')
    if (scopeDenied) throw new Error('workspaceAccessDenied')
    return value
  },
} })
mock.module(new URL('./product-rpc.ts', import.meta.url).href, { namedExports: {
  productRpc: async (currentScope: EveScope, operation: unknown) => {
    rpcCalls.push({ scope: currentScope, operation })
    return { instructions: 'factory host instructions' }
  },
} })
mock.module(new URL('./product-definitions.ts', import.meta.url).href, { namedExports: {
  async prepareEveExecution() {
    prepareCalls++
    if (prepareFails) throw new Error('preparation unavailable')
    return { execution: null, runtime: { harness: 'ai_sdk', model: 'frozen-model-' + prepareCalls } }
  },
  async asProductPrincipal(value: EveScope, work: () => Promise<unknown>) {
    principal = value
    try { return await work() } finally { principal = null }
  },
  async checkedPreparedEveExecution(_scope: EveScope, _binding: unknown, execution: unknown) { return execution },
} })
mock.module(new URL('../deployment-switches.ts', import.meta.url).href, { namedExports: {
  deploymentSwitch: () => factoryEnabled,
} })
mock.module(new URL('../factory/reconcile-pending.ts', import.meta.url).href, { namedExports: {
  async pendingFactoryReconciliation(_pool: unknown, ownerId: string, botId: string) {
    factoryReads++
    assert.equal(ownerId, scope.ownerId)
    assert.equal(botId, scope.botId)
    if (factoryFails) throw new Error('factory read unavailable')
    return factoryPending ? [{ id: 'fixture-factory-task' }] : []
  },
} })
mock.module(new URL('../coordinator/product-instructions.ts', import.meta.url).href, { namedExports: {
  async composeEveInstructions(...args: unknown[]) {
    assert.deepEqual(principal, scope)
    instructionCalls.push(args)
    return 'current local instructions ' + instructionCalls.length
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
    return scheduled ? { occurrenceId: 'fixture-occurrence', leaseToken: 'fixture-lease', allowedActions: [], prompt: 'read only' } : null
  },
} })
mock.module(new URL('./evaluation-runtime.ts', import.meta.url).href, { namedExports: {
  evaluationForSession: async () => null, evaluationModel: () => null,
} })
mock.module(new URL('../abuse/workflow-model.ts', import.meta.url).href, { namedExports: { HostedWorkflowModel: class {} } })
mock.module(new URL('../subscription-workflow-model.ts', import.meta.url).href, { namedExports: { SubscriptionWorkflowModel: class {} } })

// Use Eve's real session-local state container. Product dependencies stay inert.
const { ContextContainer, contextStorage } = await import(new URL('./context/container.js', import.meta.resolve('eve')).href)
const { executionForSession, modelForSession, instructionsForSession } = await import('./runtime')
const eveRequire = createRequire(new URL('../../apps/eve/package.json', import.meta.url))
mock.module(eveRequire.resolve('eve/connections'), { namedExports: { defineDynamic: (value: unknown) => value, defineMcpClientConnection: (value: unknown) => value } })
mock.module(eveRequire.resolve('eve/skills'), { namedExports: { defineDynamic: (value: unknown) => value, defineSkill: (value: unknown) => value } })
mock.module(new URL('../plugins/runtime.ts', import.meta.url).href, { namedExports: {
  personalPlugins: { snapshot: async () => ({ servers: [] }) },
} })
const { default: connections } = await import('../../apps/eve/agent/connections/personal')
const { default: skills } = await import('../../apps/eve/agent/skills/assigned')
const readConnections = connections as unknown as (ctx: DynamicModelContext) => Promise<unknown>
const readSkills = skills as unknown as (ctx: DynamicModelContext) => Promise<unknown>

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
  sessionChecks = factoryReads = 0
  factoryEnabled = true
  factoryPending = factoryFails = scheduled = false
  instructionCalls.length = rpcCalls.length = 0
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
    assert.equal(leaseChecks, 0)
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
  assert.equal(leaseChecks, 0)
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

test('each native model evaluation checks current scope while model and skills avoid unused schedule reads', async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    await modelForSession(definitionContext())
    scopeDenied = true
    await assert.rejects(modelForSession(definitionContext()), /workspaceAccessDenied/)
    assert.equal(leaseChecks, 0)
    scopeDenied = false
    leaseDenied = true
    await modelForSession(definitionContext())
    await readSkills(definitionContext())
    leaseDenied = false
    await modelForSession(definitionContext())
    assert.equal(prepareCalls, 1)
    assert.equal(scopeChecks, 4)
    assert.equal(leaseChecks, 0)
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
    assert.equal(leaseChecks, 0)
  })
})

test('ordinary native instructions compose locally with fresh session authority and the exact native tuple', async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    assert.equal(await instructionsForSession(definitionContext()), 'current local instructions 1')
    assert.equal(await instructionsForSession(definitionContext()), 'current local instructions 2')
    assert.deepEqual(instructionCalls, Array(2).fill([scope.ownerId, scope.botId, undefined, { sessionId: 'fixture-session', turnId: 'turn_1' }]))
    assert.equal(prepareCalls, 1)
    assert.equal(sourceReads, 1)
    assert.equal(factoryReads, 2)
    assert.equal(sessionChecks, 2)
    assert.equal(leaseChecks, 2)
    assert.equal(rpcCalls.length, 0)
    scopeDenied = true
    await assert.rejects(instructionsForSession(definitionContext()), /workspaceAccessDenied/)
    assert.equal(instructionCalls.length, 2)
  })
})

test('eligible Factory work keeps the current app-owned instructions operation and empty reads do not hide failures', async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    factoryPending = true
    assert.equal(await instructionsForSession(definitionContext()), 'factory host instructions')
    assert.deepEqual(rpcCalls, [{ scope, operation: { operation: 'instructions', sessionId: 'fixture-session', turnId: 'turn_1', executionId: undefined } }])
    assert.equal(instructionCalls.length, 0)
    factoryPending = false
    factoryFails = true
    await assert.rejects(instructionsForSession(definitionContext()), /factory read unavailable/)
    assert.equal(rpcCalls.length, 1)
    assert.equal(instructionCalls.length, 0)
    factoryFails = false
    factoryEnabled = false
    assert.equal(await instructionsForSession(definitionContext()), 'current local instructions 1')
    assert.equal(factoryReads, 2)
  })
})

test('connections and instructions retain fresh consumed schedule authority and skip private prompt assembly for scheduled and Slack surfaces', async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    await readConnections(definitionContext())
    assert.equal(leaseChecks, 1)
    leaseDenied = true
    await assert.rejects(readConnections(definitionContext()), /scheduleReadAuthorityLost/)
    await assert.rejects(instructionsForSession(definitionContext()), /scheduleReadAuthorityLost/)
    leaseDenied = false
    scheduled = true
    assert.equal(await readConnections(definitionContext()), null)
    assert.match(await instructionsForSession(definitionContext()), /authorized scheduled read-only task/)
    scheduled = false
    assert.match(await instructionsForSession(definitionContext({ currentScope: { ...scope, surface: 'slack' } })), /Use only this Slack conversation/)
    assert.equal(factoryReads, 0)
    assert.equal(instructionCalls.length, 0)
    assert.equal(rpcCalls.length, 0)
    assert.equal(leaseChecks, 6)
  })
})
