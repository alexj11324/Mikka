import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { createRequire } from 'node:module'
import { z } from 'zod'
import type { EveScope } from './scope'
import type { DynamicModelContext } from 'eve'

const scope: EveScope = {
  ownerId: 'fixture-owner', botId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002', surface: 'web',
}
const binding = { sessionId: 'fixture-session', turnId: 'turn_1', executionId: 'fixture-execution' }
const tokenWorkspace = Symbol('fixture-workspace')
const runtime = { harness: 'ai_sdk', model: 'frozen-model' }
const execution = { id: binding.executionId, snapshot: { runtime } }
const sessions: unknown[] = [], reservations: unknown[] = [], reads: unknown[] = [], principals: unknown[] = []
const statusReads: unknown[] = []
let scopeDenied = false, executionClosed = false, toolsEnabled = true, definitions = 0, fetches = 0
let source: { source_event_id: string; id: string; payload: Record<string, unknown> } | undefined
let leaseDenied = false, preparationEnabled = true
let sourceReads = 0, leaseChecks = 0, instructionReads = 0

mock.module(new URL('./scope.ts', import.meta.url).href, { namedExports: {
  scopeFromAuth: () => scope,
  assertEveScope: async () => scope,
  async assertSessionScope(actual: EveScope, sessionId: string) {
    sessions.push({ scope: actual, sessionId })
    if (scopeDenied) throw new Error('workspaceAccessDenied')
  },
} })
mock.module(new URL('../acting-user.ts', import.meta.url).href, { namedExports: {
  async actAs(principal: unknown, work: () => Promise<unknown>) { principals.push(principal); return work() },
} })
mock.module(new URL('../tokens/principal.ts', import.meta.url).href, { namedExports: { tokenWorkspace } })
mock.module(new URL('../../workflows/coordinator/agent-kit-steps.ts', import.meta.url).href, { namedExports: {
  async beginAgentExecution(...args: unknown[]) { reservations.push(args); return preparationEnabled ? execution : null },
  async botRuntime(ownerId: string, botId: string) { assert.equal(ownerId, scope.ownerId); assert.equal(botId, scope.botId); return runtime },
} })
mock.module(new URL('../agent-kit/service.ts', import.meta.url).href, { namedExports: {
  agentKitEnabled: () => true,
  agentScope: async (ownerId: string, botId: string) => ({ ownerId, botId, workspaceId: scope.workspaceId }),
  agentKitStore: { async readExecution(...args: unknown[]) {
    reads.push(args)
    if (executionClosed) throw new Error('agentExecutionClosed')
    return execution
  }, async executionStatus(...args: unknown[]) { statusReads.push(args); return executionClosed ? 'completed' : 'running' } },
} })
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {
  async query(sql: string, values: unknown[]) {
    sourceReads++
    assert.match(sql, /FROM eve_turn_sources/)
    if (values.length === 2) {
      assert.deepEqual(values, [binding.sessionId, binding.turnId])
      return { rows: source ? [{ source_event_id: source.source_event_id }] : [] }
    }
    assert.deepEqual(values, [binding.sessionId, binding.turnId, scope.ownerId, scope.botId])
    return { rows: source ? [source] : [] }
  },
} } })
mock.module(new URL('./retry-source.ts', import.meta.url).href, { namedExports: {
  async eveOriginalRequestSource(actual: EveScope, id: string) { assert.deepEqual(actual, scope); return { id, payload: {} } },
  async eveTaskRequestSource(actual: EveScope, id: string) { assert.deepEqual(actual, scope); return id },
} })
mock.module(new URL('./scheduled-read.ts', import.meta.url).href, { namedExports: {
  async loadScheduledRead(actual: EveScope) {
    leaseChecks++
    assert.deepEqual(actual, scope)
    if (leaseDenied) throw new Error('scheduleReadAuthorityLost')
    return null
  },
} })
mock.module(new URL('../personal-mailbox-capability.ts', import.meta.url).href, { namedExports: { snapshotMailboxTools: () => [] } })
mock.module(new URL('../../workflows/coordinator/steps.ts', import.meta.url).href, { namedExports: {
  isCoordinatorChat: async () => false, computerToolsEnabled: async () => toolsEnabled,
  personalWriteToolsEnabled: async () => false,
} })
mock.module(new URL('../../workflows/coordinator/tools.ts', import.meta.url).href, { namedExports: {
  readCoordinatorSwitches: () => ({}),
  coordinatorTools(ownerId: string, botId: string, _scheduled: unknown, options: { computerEnabled: boolean }) {
    definitions++
    assert.equal(ownerId, scope.ownerId); assert.equal(botId, scope.botId)
    const inputSchema = z.object({ id: z.string() })
    return { list_issues: { description: 'Read an issue', inputSchema },
      load_skill: { inputSchema }, call_personal_mcp_tool: { inputSchema },
      ...(options.computerEnabled ? { inspect_computer: { inputSchema } } : {}) }
  },
} })
const eveRequire = createRequire(new URL('../../apps/eve/package.json', import.meta.url))
mock.module(eveRequire.resolve('eve/tools'), { namedExports: { defineDynamic: (definition: unknown) => definition } })
mock.module(new URL('./evaluation-runtime.ts', import.meta.url).href, { namedExports: {
  evaluationForSession: async () => null, evaluationNativeTools: () => ({}), evaluationModel: () => null,
} })
mock.module(new URL('../deployment-switches.ts', import.meta.url).href, { namedExports: { deploymentSwitch: () => false } })
mock.module(new URL('../coordinator/product-instructions.ts', import.meta.url).href, { namedExports: {
  async composeEveInstructions() { instructionReads++; return 'local instructions' },
} })
mock.module(new URL('../abuse/workflow-model.ts', import.meta.url).href, { namedExports: { HostedWorkflowModel: class {} } })
mock.module(new URL('../subscription-workflow-model.ts', import.meta.url).href, { namedExports: { SubscriptionWorkflowModel: class {} } })
mock.module(new URL('./product-rpc.ts', import.meta.url).href, { namedExports: {
  productRpc: async () => { throw new Error('Native instruction HTTP is forbidden for this fixture') },
} })
mock.module(new URL('./product-tool.ts', import.meta.url).href, { namedExports: {
  createProductTool: (actual: EveScope, current: unknown, definition: { name: string }) => {
    assert.deepEqual(actual, scope); assert.deepEqual(current, binding)
    return { name: definition.name }
  },
} })

const { prepareEveExecution, productCatalogue } = await import('./product-definitions')
const { instructionsForSession } = await import('./runtime')
const { ContextContainer, contextStorage } = await import(new URL('./context/container.js', import.meta.resolve('eve')).href)
const { default: nativeProductTools } = await import('../../apps/eve/agent/tools/product')
const context = { session: { id: binding.sessionId, auth: { current: { attributes: scope } } }, turn: { id: binding.turnId },
  memo: async (_key: unknown, work: () => Promise<unknown>) => work() } as unknown as DynamicModelContext

beforeEach(() => {
  sessions.length = reservations.length = reads.length = principals.length = 0
  statusReads.length = 0
  scopeDenied = executionClosed = leaseDenied = false
  toolsEnabled = preparationEnabled = true
  source = undefined
  definitions = fetches = 0
  sourceReads = leaseChecks = instructionReads = 0
  mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('Definition HTTP callbacks are forbidden') })
})

test('native preparation uses the existing execution writer and exact persisted session without HTTP', async () => {
  assert.deepEqual(await prepareEveExecution(scope, binding.sessionId, binding.turnId), { execution, runtime })
  assert.deepEqual(sessions, [{ scope, sessionId: binding.sessionId }])
  assert.deepEqual(reservations, [[scope.ownerId, scope.botId, `${binding.sessionId}:${binding.turnId}`, 0, { harness: 'ai_sdk' }]])
  assert.deepEqual(principals, [{ id: scope.ownerId, [tokenWorkspace]: scope.workspaceId }])
  preparationEnabled = false
  assert.deepEqual(await prepareEveExecution(scope, binding.sessionId, binding.turnId), { execution: null, runtime })
  scopeDenied = true
  await assert.rejects(prepareEveExecution(scope, binding.sessionId, binding.turnId), /workspaceAccessDenied/)
  assert.equal(reservations.length, 2)
  assert.equal(fetches, 0)
})

test('the native tools definition refreshes the local catalogue and bound running execution before each model call', async () => {
  const evaluate = nativeProductTools as unknown as (ctx: unknown) => Promise<Record<string, { name: string }>>
  await contextStorage.run(new ContextContainer(), async () => {
    assert.deepEqual(Object.keys(await evaluate(context)), ['list_issues', 'inspect_computer'])
    toolsEnabled = false
    assert.deepEqual(Object.keys(await evaluate(context)), ['list_issues'])
    assert.equal(reads.length, 0)
    assert.deepEqual(statusReads, Array(2).fill([{ ownerId: scope.ownerId, botId: scope.botId, workspaceId: scope.workspaceId }, binding.executionId]))
    assert.equal(reservations.length, 1)
    assert.equal(definitions, 2)
    executionClosed = true
    await assert.rejects(evaluate(context), /agentExecutionClosed/)
    assert.equal(definitions, 2)
    assert.equal(fetches, 0)
  })
})

test('native catalogue reads scheduled authority once and local instructions reject an execution closed after catalogue', async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    source = { source_event_id: 'fixture-source', id: 'fixture-source', payload: {} }
    const evaluate = nativeProductTools as unknown as (ctx: unknown) => Promise<unknown>
    await evaluate(context)
    assert.equal(leaseChecks, 1)
    assert.equal(sourceReads, 2, 'one durable source ID and one current catalogue context')
    assert.equal(reads.length, 0, 'the prepared immutable snapshot is reused')
    executionClosed = true
    await assert.rejects(instructionsForSession(context), /agentExecutionClosed/)
    assert.equal(statusReads.length, 2, 'catalogue and instructions each check current execution state')
    assert.equal(instructionReads, 0)
    assert.equal(fetches, 0)
  })
})

test('local discovery preserves schema, private scope and fresh scheduled authority', async () => {
  const catalogue = await productCatalogue(scope, binding)
  assert.equal(catalogue[0].inputSchema.type, 'object')
  assert.deepEqual(catalogue[0].inputSchema.required, ['id'])
  assert.equal(catalogue[0].needsApprovalReview, false)
  assert.deepEqual(reads, [[{ ownerId: scope.ownerId, botId: scope.botId, workspaceId: scope.workspaceId }, binding.executionId, `${binding.sessionId}:${binding.turnId}:0`]])
  scopeDenied = true
  await assert.rejects(productCatalogue(scope, binding), /workspaceAccessDenied/)
  scopeDenied = false
  source = { source_event_id: 'fixture-source', id: 'fixture-source', payload: {} }
  leaseDenied = true
  await assert.rejects(productCatalogue(scope, binding), /scheduleReadAuthorityLost/)
  assert.equal(definitions, 1)
  assert.equal(fetches, 0)
})

test('prepared native execution must match the binding before any current status read', async () => {
  const { checkedPreparedEveExecution } = await import('./product-definitions')
  await assert.rejects(checkedPreparedEveExecution(scope, { ...binding, executionId: 'different-execution' }, execution as never), /agentExecutionClosed/)
  await assert.rejects(checkedPreparedEveExecution(scope, binding, null), /agentExecutionClosed/)
  assert.equal(statusReads.length, 0)
})
