import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { DEFAULT_AGENT_DEFINITION } from './builtin'
import { AgentKitStore, type AgentExecution } from './store'

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const owner = 'synthetic-owner', bot = id(1), holder = 'synthetic-workflow'
const scope = { ownerId: owner, botId: bot, workspaceId: id(2) }
const definition = { ...DEFAULT_AGENT_DEFINITION, hooks: ['audit' as const] }
const runtime = { harness: 'ai_sdk' as const, model: 'saved-model' }
const prepared = { mailboxTools: [], prompt: { instructions: 'saved policy', messages: [] }, contextMs: { execution: 3, personal: 1, github: 2 } }

/** Real Store transactions and replay logic with an isolated SQL adapter, not PostgreSQL. */
function repository() {
  const executions = new Map<string, AgentExecution>()
  const events = new Map<string, { kind: string; payload: unknown }>()
  const queries: string[] = []
  const version = { id: id(10), version: 1, definition, digest: 'fixture', source: 'user', base_version: null }
  const client = { release() {}, async query(sql: string, args: unknown[] = []) {
    queries.push(sql)
    if (['begin', 'commit', 'rollback'].includes(sql)) return { rows: [] }
    if (sql.startsWith('select id from bots')) {
      assert.deepEqual(args, [scope.botId, scope.ownerId, scope.workspaceId])
      return { rows: [{ id: bot }], rowCount: 1 }
    }
    if (sql.startsWith('insert into agent_kit_heads')) return { rows: [] }
    if (sql.startsWith('select active_version')) return { rows: [{ active_version: version.id, workspace_id: scope.workspaceId }] }
    if (sql.startsWith('select id,version,definition')) return { rows: [version] }
    if (sql.startsWith('select id,snapshot,status from agent_kit_executions')) {
      const row = executions.get(String(args[2]))
      return { rows: row ? [structuredClone(row)] : [] }
    }
    if (sql.startsWith('insert into agent_kit_executions')) {
      executions.set(String(args[3]), { id: String(args[0]), snapshot: JSON.parse(String(args[5])), status: 'running' })
      return { rows: [] }
    }
    if (sql.startsWith('select status,coalesce') || sql.startsWith('select id,status,coalesce')) {
      const row = sql.includes('execution_key=$3') ? executions.get(String(args[2])) : [...executions.values()].find(item => item.id === args[2])
      return { rows: row ? [{ id: row.id, status: row.status, tool_allowed: false, failure_cases: false, revision: row.snapshot.revision, revision_id: row.snapshot.revisionId }] : [] }
    }
    if (sql.startsWith('select kind,payload from agent_kit_events')) {
      const row = events.get(`${args[0]}:${args[1]}`)
      return { rows: row ? [row] : [] }
    }
    if (sql.startsWith('insert into agent_kit_events')) {
      events.set(`${args[0]}:${args[3]}`, { kind: String(args[4]), payload: JSON.parse(String(args[5])) })
      return { rows: [] }
    }
    if (sql.startsWith('update agent_kit_executions set status=')) {
      const row = [...executions.values()].find(item => item.id === args[0])
      assert.ok(row); row.status = args[1] as AgentExecution['status']
      return { rows: [] }
    }
    throw new Error(`Unexpected isolated query: ${sql}`)
  } }
  return { store: new AgentKitStore({ connect: async () => client } as unknown as ConstructorParameters<typeof AgentKitStore>[0]), executions, events, queries }
}

let fixture: ReturnType<typeof repository>
let enabled = true, flagReads = 0, resolutions = 0, plugins = 0, host = 'saved policy'
let prepareFailure: Error | null = null
const calls: Array<{ name: string; args: unknown[] }> = []
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
const forbidden = () => { throw new Error('No external model, database or tool in preparation fixture') }
stub('./service.ts', {
  agentKitEnabled: () => { flagReads++; return enabled },
  agentKitDefaults: () => definition,
  agentScope: async (...args: unknown[]) => { calls.push({ name: 'scope', args }); return scope },
  agentKitStore: {
    beginExecution: (...args: Parameters<AgentKitStore['beginExecution']>) => fixture.store.beginExecution(...args),
    finishExecution: (...args: Parameters<AgentKitStore['finishExecution']>) => fixture.store.finishExecution(...args),
    failExecutionByKey: (...args: Parameters<AgentKitStore['failExecutionByKey']>) => fixture.store.failExecutionByKey(...args),
    propose: forbidden,
  },
})
stub('../bot-model-selection.ts', { freezeBotModel: async () => { resolutions++; return runtime } })
stub('../subscription-runtime.ts', { authorizeSubscriptionWorkspace: forbidden, subscriptionRuntime: forbidden })
stub('../coordinator/bot-instructions.ts', { botInstructions: async () => host })
stub('../coordinator/instructions.ts', { COORDINATOR_INSTRUCTIONS: 'synthetic host' })
stub('../coordinator/native-prompt.ts', { personalCoordinatorInstructions: () => 'synthetic native' })
stub('../plugins/runtime.ts', { personalPlugins: { snapshot: async () => { plugins++; return { servers: [], skills: [] } } } })
stub('../../workflows/coordinator/tool-scope.ts', { assertNativeToolScope: forbidden })
stub('../../workflows/coordinator/steps.ts', { prepareTurn: async (...args: unknown[]) => {
  calls.push({ name: 'prepare', args })
  if (prepareFailure) throw prepareFailure
  return prepared
} })
let prepareRound: typeof import('../../workflows/coordinator/round-preparation').prepareHostedAgentRound
let steps: typeof import('../../workflows/coordinator/agent-kit-steps')
before(async () => {
  ;({ prepareHostedAgentRound: prepareRound } = await import('../../workflows/coordinator/round-preparation'))
  steps = await import('../../workflows/coordinator/agent-kit-steps')
})
beforeEach(() => {
  fixture = repository(); calls.length = 0
  enabled = true; flagReads = 0; resolutions = 0; plugins = 0; host = 'saved policy'; prepareFailure = null
})

test('the real combined step prepares the exact Store snapshot and returns its persisted identity', async () => {
  const result = await prepareRound(owner, bot, holder, 2, { harness: 'ai_sdk' }, true, false, true)
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') throw new Error('expected enabled preparation')
  assert.deepEqual(result.execution, fixture.executions.get(`${holder}:2`))
  assert.deepEqual(calls.map(call => call.name), ['scope', 'prepare'])
  assert.deepEqual(calls[0].args, [owner, bot])
  assert.deepEqual(calls[1].args, [owner, bot, holder, { snapshot: result.execution.snapshot, executionId: result.execution.id, mailboxEnabled: true, runtime: result.execution.snapshot.runtime }])
  assert.equal(result.hosted, result.execution.snapshot.runtime)
  assert.equal(result.prepared, prepared)
  assert.deepEqual(Object.keys(result.bodyMs).sort(), ['begin', 'prepare'])
  assert.ok(Object.values(result.bodyMs).every(value => Number.isFinite(value) && value >= 0))
  assert.equal('bodyMs' in result.prepared, false)
  assert.equal(resolutions, 1); assert.equal(plugins, 1)
})

test('a frozen disabled kit stays disabled when the live switch turns on, with no scope or SQL', async () => {
  const result = await prepareRound(owner, bot, holder, 0, { harness: 'ai_sdk' }, false, false, false)
  assert.deepEqual(result, { kind: 'disabled' })
  assert.equal(calls.length, 0); assert.equal(fixture.queries.length, 0)
  assert.equal(resolutions, 0); assert.equal(plugins, 0); assert.equal(flagReads, 0)
})

test('a replayed harness mismatch is rejected before prompt preparation', async () => {
  await fixture.store.beginExecution(scope, `${holder}:0`, host, { harness: 'codex', model: null }, definition)
  await assert.rejects(prepareRound(owner, bot, holder, 0, { harness: 'ai_sdk' }, false, false, true), /agent_runtime_changed/)
  assert.equal(calls.filter(call => call.name === 'prepare').length, 0)
  assert.equal(resolutions, 0); assert.equal(plugins, 0)
})

test('scheduled preparation keeps its snapshot but cannot publish a model-switch notice', async () => {
  const result = await prepareRound(owner, bot, holder, 0, { harness: 'ai_sdk' }, true, true, true)
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') throw new Error('expected enabled preparation')
  const input = calls.find(call => call.name === 'prepare')!.args[3] as { snapshot: unknown; runtime: unknown }
  assert.equal(input.snapshot, result.execution.snapshot)
  assert.equal(input.runtime, null)
})

for (const terminal of ['completed', 'failed'] as const) test(`a switch change between real preparation attempts preserves the execution and ${terminal} cleanup`, async () => {
  const error = new Error('synthetic_prepare_unavailable'); prepareFailure = error
  await assert.rejects(prepareRound(owner, bot, holder, 0, { harness: 'ai_sdk' }, false, false, true), value => value === error)
  const committed = structuredClone(fixture.executions.get(`${holder}:0`))
  assert.ok(committed); assert.equal(committed.status, 'running')
  assert.equal(resolutions, 1); assert.equal(plugins, 1)
  enabled = false; host = 'changed policy after the first reservation'
  if (terminal === 'completed') {
    prepareFailure = null
    const replay = await prepareRound(owner, bot, holder, 0, { harness: 'ai_sdk' }, false, false, true)
    assert.equal(replay.kind, 'ready', 'the frozen run setting must not become a disabled preparation on retry')
    if (replay.kind !== 'ready') throw new Error('expected replayed execution')
    assert.deepEqual(replay.execution, committed)
    await steps.finishAgentExecution(owner, bot, replay.execution.id)
  } else {
    await assert.rejects(prepareRound(owner, bot, holder, 0, { harness: 'ai_sdk' }, false, false, true), value => value === error)
    await steps.failAgentPreparation(owner, bot, holder, 0)
  }
  assert.equal(fixture.executions.size, 1)
  assert.equal(fixture.executions.get(`${holder}:0`)?.status, terminal)
  assert.deepEqual(fixture.executions.get(`${holder}:0`)?.snapshot, committed.snapshot)
  assert.equal(fixture.events.size, 1)
  assert.equal(calls.filter(call => call.name === 'prepare').length, 2)
  assert.equal(calls.filter(call => call.name === 'scope').length, 3, 'both attempts and terminal cleanup recheck authority')
  assert.equal(resolutions, 1); assert.equal(plugins, 1); assert.equal(flagReads, 0)
})

test('the original public SDK and native reservation still read the live switch', async () => {
  enabled = false
  for (const selected of [{ harness: 'ai_sdk' as const }, { harness: 'codex' as const, deviceId: bot }]) {
    assert.equal(await steps.beginAgentExecution(owner, bot, holder, 0, selected), null)
  }
  assert.equal(flagReads, 2); assert.equal(calls.length, 0); assert.equal(fixture.queries.length, 0)
})
