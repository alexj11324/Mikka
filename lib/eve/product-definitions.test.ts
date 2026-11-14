import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { createRequire } from 'node:module'
import { z } from 'zod'
import type { EveScope } from './scope'
import type { DynamicModelContext } from 'eve'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'

const scope: EveScope = {
  ownerId: 'fixture-owner', botId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002', surface: 'web',
}
const binding = { sessionId: 'fixture-session', turnId: 'turn_1', executionId: 'fixture-execution' }
const tokenWorkspace = Symbol('fixture-workspace')
const runtime = { harness: 'ai_sdk' as const, model: 'frozen-model' }
const policy = { definition: DEFAULT_AGENT_DEFINITION, effectiveTools: ['list_issues', 'inspect_computer'] }
const execution = { id: binding.executionId, snapshot: { runtime } }
const reservations: unknown[] = [], reads: unknown[] = [], principals: unknown[] = [], toolOptions: unknown[] = [], allocationQueries: string[] = []
let executionClosed = false, toolsEnabled = true, writesEnabled = false, definitions = 0, fetches = 0
let source: { source_event_id: string; id: string; payload: Record<string, unknown> } | undefined
let leaseDenied = false, preparationEnabled = true, agentKitEnabled = true, settled = false
let sourceReads = 0, leaseChecks = 0

mock.module(new URL('./scope.ts', import.meta.url).href, { namedExports: { scopeFromAuth: () => scope } })
mock.module(new URL('./product-rpc.ts', import.meta.url).href, { namedExports: {
  productRpc: async () => { throw new Error('Definition HTTP callbacks are forbidden') },
} })
mock.module(new URL('../acting-user.ts', import.meta.url).href, { namedExports: {
  async actAs(principal: unknown, work: () => Promise<unknown>) { principals.push(principal); return work() },
} })
mock.module(new URL('../tokens/principal.ts', import.meta.url).href, { namedExports: { tokenWorkspace } })
mock.module(new URL('../../workflows/coordinator/agent-kit-steps.ts', import.meta.url).href, { namedExports: {
  async beginAgentExecution(...args: unknown[]) { reservations.push(args); return preparationEnabled ? execution : null },
  async botRuntime() { return runtime },
} })
mock.module(new URL('../agent-kit/service.ts', import.meta.url).href, { namedExports: {
  agentKitEnabled: () => agentKitEnabled,
  agentScope: async (ownerId: string, botId: string) => ({ ownerId, botId, workspaceId: scope.workspaceId }),
  agentKitStore: { async readExecution(...args: unknown[]) {
    reads.push(args)
    if (executionClosed) throw new Error('agentExecutionClosed')
    return execution
  } },
} })
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {
  async query(sql: string, values: unknown[]) {
    sourceReads++
    assert.match(sql, /FROM eve_turn_sources/)
    assert.deepEqual(values, [binding.sessionId, binding.turnId, scope.ownerId, scope.botId])
    return { rows: source ? [source] : [] }
  },
} } })
mock.module(new URL('../db/direct-session.ts', import.meta.url).href, { namedExports: {
  async withDirectSession(_database: unknown, work: (client: { query(sql: string, values: unknown[]): Promise<unknown> }) => Promise<unknown>) {
    return work({ async query(sql, values) {
      allocationQueries.push(sql)
      if (sql.includes('pg_advisory_lock')) {
        assert.deepEqual(values, [`eve-settlement:${binding.sessionId}:${binding.turnId}`])
        return { rows: [], rowCount: 1 }
      }
      assert.match(sql, /FROM eve_turn_settlements/)
      assert.deepEqual(values, [binding.sessionId, binding.turnId])
      return { rows: settled ? [{}] : [], rowCount: settled ? 1 : 0 }
    } })
  },
} })
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
  personalWriteToolsEnabled: async () => writesEnabled,
} })
mock.module(new URL('../../workflows/coordinator/tools.ts', import.meta.url).href, { namedExports: {
  readCoordinatorSwitches: () => ({}), coordinatorWriteCatalogue: [],
  coordinatorTools(ownerId: string, botId: string, _scheduled: unknown, options: { computerEnabled: boolean }) {
    definitions++
    toolOptions.push(options)
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
mock.module(new URL('./product-tool.ts', import.meta.url).href, { namedExports: {
  createProductTool: (actual: EveScope, current: unknown, definition: { name: string }) => {
    assert.deepEqual(actual, scope)
    assert.deepEqual(current, { sessionId: binding.sessionId, turnId: binding.turnId })
    return { name: definition.name }
  },
} })

const { beginProductAction, productCatalogue, productContext } = await import('./product-definitions')
const { turnModel, turnPolicy, turnRequest } = await import('./runtime')
const { ContextContainer, contextStorage } = await import(new URL('./context/container.js', import.meta.resolve('eve')).href)
const { default: nativeProductTools } = await import('../../apps/eve/agent/tools/product')
const context = { session: { id: binding.sessionId, auth: { current: { attributes: scope } } }, turn: { id: binding.turnId } } as unknown as DynamicModelContext

beforeEach(() => {
  reservations.length = reads.length = principals.length = toolOptions.length = allocationQueries.length = 0
  executionClosed = leaseDenied = false
  writesEnabled = settled = false
  toolsEnabled = preparationEnabled = agentKitEnabled = true
  source = undefined
  definitions = fetches = sourceReads = leaseChecks = 0
  mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('Definition HTTP callbacks are forbidden') })
})

test('native discovery reads business capabilities without allocating or reading action executions', async () => {
  const evaluate = nativeProductTools as unknown as (ctx: unknown) => Promise<Record<string, { name: string }>>
  await contextStorage.run(new ContextContainer(), async () => {
    turnModel.update(() => runtime)
    turnPolicy.update(() => policy)
    turnRequest.update(() => ({ sourceEventId: 'fixture-source', scheduledRead: null }))
    assert.deepEqual(Object.keys(await evaluate(context)), ['list_issues', 'inspect_computer'])
    toolsEnabled = false
    assert.deepEqual(Object.keys(await evaluate(context)), ['list_issues'])
    assert.equal(reservations.length, 0)
    assert.equal(reads.length, 0)
    assert.equal(sourceReads, 0)
    assert.equal(leaseChecks, 0)
    assert.equal(definitions, 2)
    assert.equal(fetches, 0)
  })
})

test('native catalogue preserves schemas and supplies the scheduled occurrence directly to business tools', async () => {
  const scheduledRead = { occurrenceId: 'fixture-occurrence', leaseToken: 'fixture-lease', allowedActions: ['list_issues'], prompt: 'Read only' }
  const catalogue = await productCatalogue(scope, binding, policy, runtime, { sourceEventId: 'fixture-source', scheduledRead })
  assert.equal(catalogue[0].inputSchema.type, 'object')
  assert.deepEqual(catalogue[0].inputSchema.required, ['id'])
  assert.equal(catalogue[0].needsApprovalReview, false)
  assert.equal((toolOptions[0] as { readOnly: boolean }).readOnly, true)
  assert.deepEqual((toolOptions[0] as { readToolIds: string[] }).readToolIds, ['list_issues'])
  assert.deepEqual(principals, [{ id: scope.ownerId, [tokenWorkspace]: scope.workspaceId }])
  assert.equal(sourceReads + leaseChecks + reservations.length + reads.length, 0)
})

test('the first action allocates its existing business execution and binds the current running key', async () => {
  const action = { sessionId: binding.sessionId, turnId: binding.turnId }
  assert.equal(await beginProductAction(scope, action), binding.executionId)
  assert.deepEqual(reservations, [[scope.ownerId, scope.botId, `${binding.sessionId}:${binding.turnId}`, 0, { harness: 'ai_sdk' }]])
  assert.equal(reads.length, 0)
  assert.equal(allocationQueries.length, 2)
  assert.equal(await beginProductAction(scope, action), binding.executionId)
  assert.equal(reservations.length, 2)
  await assert.rejects(productContext(scope, action), /agentExecutionClosed/)
})

test('existing action bindings retain current execution and scheduled authority', async () => {
  source = { source_event_id: 'fixture-source', id: 'fixture-source', payload: {} }
  await productContext(scope, binding)
  assert.equal(reservations.length, 0)
  assert.equal(reads.length, 1)
  assert.equal(leaseChecks, 1)
  leaseDenied = true
  await assert.rejects(productContext(scope, binding), /scheduleReadAuthorityLost/)
})

test('a delayed first action cannot allocate an execution after the turn has settled', async () => {
  settled = true
  await assert.rejects(beginProductAction(scope, { sessionId: binding.sessionId, turnId: binding.turnId }), /agentExecutionClosed/)
  assert.equal(reservations.length + reads.length, 0)
  assert.equal(allocationQueries.length, 2)
})

test('AgentKit-off discovery and actions keep their existing execution-free behavior', async () => {
  agentKitEnabled = false
  writesEnabled = true
  await contextStorage.run(new ContextContainer(), async () => {
    turnModel.update(() => runtime)
    turnPolicy.update(() => null)
    const evaluate = nativeProductTools as unknown as (ctx: unknown) => Promise<Record<string, unknown>>
    assert.deepEqual(Object.keys(await evaluate(context)), ['list_issues', 'inspect_computer'])
    assert.equal((toolOptions[0] as { writeEnabled: boolean }).writeEnabled, false)
  })
  assert.equal(await beginProductAction(scope, binding), undefined)
  const result = await productContext(scope, { sessionId: binding.sessionId, turnId: binding.turnId })
  assert.equal(result.execution, null)
  assert.equal(reservations.length + reads.length, 0)
})
