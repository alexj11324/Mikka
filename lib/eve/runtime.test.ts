import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { createRequire } from 'node:module'
import type { DynamicModelContext } from 'eve'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'
import type { HostedRuntimeSnapshot } from '../subscription-model-snapshot'
import type { EveScope } from './scope'

const scope: EveScope = {
  ownerId: 'fixture-owner', botId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002', surface: 'web',
}
const serverId = '00000000-0000-4000-8000-000000000003'
let runtime: HostedRuntimeSnapshot = { harness: 'ai_sdk', model: 'fixture-model' }
let definition = { ...DEFAULT_AGENT_DEFINITION, instructions: 'Bot guidance', tools: ['web_search'] as typeof DEFAULT_AGENT_DEFINITION.tools }
let modelReads = 0, policyReads = 0, pluginReads = 0, sourceReads = 0, scheduleReads = 0
let scheduled = false
let evaluation: { instructions: string } | null = null
const instructionCalls: unknown[] = [], rpcCalls: unknown[] = [], modelCalls: unknown[] = []
let principal: EveScope | null = null
const plugins = () => ({ servers: [{ id: serverId, name: 'Fixture MCP', revision: 1 }], skills: [], toolkits: [] })

mock.module(new URL('./scope.ts', import.meta.url).href, { namedExports: {
  scopeFromAuth: (auth: { attributes: { surface: EveScope['surface'] } }) => ({ ...scope, surface: auth.attributes.surface }),
  async registerSession() {},
} })
mock.module(new URL('./product-rpc.ts', import.meta.url).href, { namedExports: {
  productRpc: async (currentScope: EveScope, operation: unknown) => {
    rpcCalls.push({ scope: currentScope, operation })
    return { instructions: 'factory host instructions' }
  },
} })
mock.module(new URL('./product-definitions.ts', import.meta.url).href, { namedExports: {
  async asProductPrincipal(value: EveScope, work: () => Promise<unknown>) {
    principal = value
    try { return await work() } finally { principal = null }
  },
} })
mock.module(new URL('../../workflows/coordinator/agent-kit-steps.ts', import.meta.url).href, { namedExports: {
  async botRuntime(ownerId: string, botId: string) {
    assert.equal(ownerId, scope.ownerId)
    assert.equal(botId, scope.botId)
    assert.deepEqual(principal, scope)
    modelReads++
    return runtime
  },
  async beginAgentExecution() { throw new Error('Definitions cannot allocate an action execution') },
} })
mock.module(new URL('../agent-kit/service.ts', import.meta.url).href, { namedExports: {
  agentKitEnabled: () => true,
  agentKitDefaults: () => DEFAULT_AGENT_DEFINITION,
  agentKitStore: { async active(value: EveScope) {
    assert.deepEqual(value, scope)
    policyReads++
    return { definition, effectiveTools: [...definition.tools] }
  } },
} })
mock.module(new URL('../plugins/runtime.ts', import.meta.url).href, { namedExports: {
  personalPlugins: {
    async snapshot() { pluginReads++; return plugins() },
    async mcpConnection() { return { transport: 'http', name: 'Fixture MCP', url: 'https://fixture.invalid/mcp', headers: {} } },
  },
} })
mock.module(new URL('../coordinator/product-instructions.ts', import.meta.url).href, { namedExports: {
  async composeEveInstructions(...args: unknown[]) {
    assert.deepEqual(principal, scope)
    instructionCalls.push(args)
    return 'current local instructions ' + instructionCalls.length
  },
} })
mock.module(new URL('../coordinator/instructions.ts', import.meta.url).href, { namedExports: { COORDINATOR_INSTRUCTIONS: 'Host policy' } })
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {
  async query(sql: string) {
    sourceReads++
    if (sql.startsWith('SELECT source_event_id')) return { rows: [{ source_event_id: 'fixture-parent-source' }] }
    assert.match(sql, /^INSERT INTO eve_turn_sources/)
    return { rows: [] }
  },
} } })
mock.module(new URL('./scheduled-read.ts', import.meta.url).href, { namedExports: {
  async loadScheduledRead() {
    scheduleReads++
    return scheduled ? { occurrenceId: 'fixture-occurrence', leaseToken: 'fixture-lease', allowedActions: [], prompt: 'read only' } : null
  },
} })
mock.module(new URL('./projection.ts', import.meta.url).href, { namedExports: {
  async projectTurnState() {}, projectEveTurn: () => [],
} })
mock.module(new URL('./evaluation-runtime.ts', import.meta.url).href, { namedExports: {
  evaluationForSession: async () => evaluation,
  evaluationModel: () => ({ modelId: 'evaluation-model' }),
} })
mock.module(new URL('../abuse/workflow-model.ts', import.meta.url).href, { namedExports: { HostedWorkflowModel: class {
  modelId: string
  constructor(ownerId: string, botId: string, modelId: string) { this.modelId = modelId; modelCalls.push({ ownerId, botId, modelId }) }
} } })
mock.module(new URL('../subscription-workflow-model.ts', import.meta.url).href, { namedExports: { SubscriptionWorkflowModel: class {
  modelId: string
  provider = 'fixture.subscription'
  supportedUrls = {}
  constructor(selection: { modelId: string }) { this.modelId = selection.modelId; modelCalls.push(selection) }
} } })

const { ContextContainer, contextStorage } = await import(new URL('./context/container.js', import.meta.resolve('eve')).href)
const { modelForSession, instructionsForSession, turnModel, turnPolicy, turnRequest } = await import('./runtime')
const eveRequire = createRequire(new URL('../../apps/eve/package.json', import.meta.url))
mock.module(eveRequire.resolve('eve/hooks'), { namedExports: { defineHook: (value: unknown) => value } })
mock.module(eveRequire.resolve('eve/connections'), { namedExports: { defineDynamic: (value: unknown) => value, defineMcpClientConnection: (value: unknown) => value } })
mock.module(eveRequire.resolve('eve/skills'), { namedExports: { defineDynamic: (value: unknown) => value, defineSkill: (value: unknown) => value } })
const { default: productHook } = await import('../../apps/eve/agent/hooks/product')
const { default: connections } = await import('../../apps/eve/agent/connections/personal')
const { default: skills } = await import('../../apps/eve/agent/skills/assigned')
const started = (productHook as unknown as { events: { 'turn.started': (event: { data: { turnId: string } }, ctx: DynamicModelContext) => Promise<void> } }).events['turn.started']
const readConnections = connections as unknown as (ctx: DynamicModelContext) => Promise<unknown>
const readSkills = skills as unknown as (ctx: DynamicModelContext) => Promise<unknown>

function context({ turnId = 'turn_1', parent = false, evaluated = false, surface = 'web' as EveScope['surface'] } = {}): DynamicModelContext {
  return {
    session: { id: 'fixture-session', auth: { current: {
      authenticator: 'mikka', attributes: { ...scope, surface, ...parent ? {} : { sourceEventId: 'fixture-source' }, ...evaluated ? { evaluationBindingId: 'fixture-evaluation' } : {} },
    } }, ...parent ? { parent: { sessionId: 'fixture-parent', turn: { id: 'parent-turn' } } } : {} },
    turn: { id: turnId },
  } as unknown as DynamicModelContext
}

beforeEach(() => {
  modelReads = policyReads = pluginReads = sourceReads = scheduleReads = 0
  scheduled = false
  evaluation = null
  runtime = { harness: 'ai_sdk', model: 'fixture-model' }
  definition = { ...DEFAULT_AGENT_DEFINITION, instructions: 'Bot guidance', tools: ['web_search'] }
  instructionCalls.length = rpcCalls.length = modelCalls.length = 0
})

test('the native turn hook chooses business capabilities once and definitions allocate no action execution', async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = context()
    await started({ data: { turnId: 'turn_1' } }, ctx)
    for (let step = 0; step < 2; step++) {
      assert.equal((await modelForSession(ctx)).modelId, 'fixture-model')
      await readConnections(ctx)
      await readSkills(ctx)
      await instructionsForSession(ctx)
    }
    assert.equal(modelReads, 1)
    assert.equal(policyReads, 1)
    assert.equal(pluginReads, 1)
    assert.equal(sourceReads, 1)
    assert.equal(scheduleReads, 1)
    assert.equal(rpcCalls.length, 0)
    assert.equal(turnPolicy.get()?.definition.instructions, 'Bot guidance')
    assert.deepEqual(turnPolicy.get()?.effectiveTools, ['web_search', 'list_personal_mcp_tools', 'call_personal_mcp_tool'])
    assert.deepEqual(instructionCalls[0], [scope.ownerId, scope.botId, undefined, { sessionId: 'fixture-session', turnId: 'turn_1' }, turnPolicy.get()])
  })
})

test('shared subscription references survive native state restoration and keep their original owner', async () => {
  const selection = { type: 'subscription' as const, bindingId: serverId, ownerId: 'subscription-owner', consumerId: scope.botId,
    workspaceId: scope.workspaceId, connectionId: serverId, connectionRevision: 7, modelId: 'shared-model', route: 'codex_cpa' as const }
  runtime = { harness: 'ai_sdk', model: 'shared-model', modelSelection: selection }
  const original = new ContextContainer()
  await contextStorage.run(original, () => started({ data: { turnId: 'turn_1' } }, context()))
  const restored = new ContextContainer()
  for (const [key, value] of original.entries()) restored.set(key, structuredClone(value))
  await contextStorage.run(restored, async () => {
    assert.equal((await modelForSession(context())).modelId, 'shared-model')
    assert.deepEqual(modelCalls, [selection])
    assert.deepEqual(turnModel.get()?.modelSelection, selection)
    assert.equal(modelReads, 1)
  })
})

test('a new turn replaces the native model and current Bot policy', async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    await started({ data: { turnId: 'turn_1' } }, context())
    runtime = { harness: 'ai_sdk', model: 'next-model' }
    definition = { ...definition, instructions: 'Updated Bot guidance', tools: ['list_issues'] }
    await started({ data: { turnId: 'turn_2' } }, context({ turnId: 'turn_2' }))
    assert.equal((await modelForSession(context({ turnId: 'turn_2' }))).modelId, 'next-model')
    assert.equal(turnPolicy.get()?.definition.instructions, 'Updated Bot guidance')
    assert.deepEqual(turnPolicy.get()?.effectiveTools, ['list_issues', 'list_personal_mcp_tools', 'call_personal_mcp_tool'])
    assert.equal(modelReads, 2)
  })
})

test('delegated scheduled work keeps its original read-only occurrence without repeated schedule reads', async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    scheduled = true
    const ctx = context({ parent: true })
    await started({ data: { turnId: 'turn_1' } }, ctx)
    assert.equal(turnRequest.get().sourceEventId, 'fixture-parent-source')
    assert.equal(await readConnections(ctx), null)
    assert.match(await instructionsForSession(ctx), /authorized scheduled read-only task/)
    assert.equal(scheduleReads, 1)
    assert.equal(instructionCalls.length, 0)
  })
})

test('Slack instructions skip private web memory, profile and Factory composition', async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const instructions = await instructionsForSession(context({ surface: 'slack' }))
    assert.match(instructions, /^Host policy\nUse only this Slack conversation/)
    assert.equal(instructionCalls.length + rpcCalls.length, 0)
  })
})

test('evaluation hooks and definitions leave business model and private capabilities untouched', async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = context({ evaluated: true })
    await started({ data: { turnId: 'turn_1' } }, ctx)
    evaluation = { instructions: 'Evaluation instructions' }
    assert.equal((await modelForSession(ctx)).modelId, 'evaluation-model')
    assert.equal(await instructionsForSession(ctx), 'Evaluation instructions')
    assert.equal(await readConnections(ctx), null)
    assert.equal(await readSkills(ctx), null)
    assert.equal(modelReads + policyReads + pluginReads + sourceReads + scheduleReads, 0)
  })
})
