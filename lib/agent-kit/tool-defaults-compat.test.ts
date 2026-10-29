import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { asSchema, type ToolSet } from 'ai'
import { DEFAULT_AGENT_DEFINITION, builtinAgentDefinition } from './builtin'
import { COMPUTER_TOOL_IDS, FACTORY_TOOL_IDS } from './registry'
import { makeSnapshot, parseDefinition, exportDefinition, importDefinition, digest } from './definition'
import { AgentKitStore, type AgentExecution } from './store'

const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
const calls: {name: string; args: unknown[]}[] = []
const capture = (name: string) => async (...args: unknown[]) => { calls.push({name, args}); return {status: 'synthetic-only'} }
const forbidden = () => { throw Error('No DB, provider or device in catalogue tests') }
stub('../db/index.ts', {db: {select: forbidden}, pool: {connect: forbidden}})
stub('../workspace-db.ts', {workspaceDb: {select: forbidden}})
stub('../../workflows/coordinator/steps.ts', {composioAction: capture('read'), proposeAccountAction: capture('propose'), wakeComputerBot: capture('wake'), dispatchRun: capture('ordinary-dispatch'), dispatchFactoryRunStep: capture('factory-dispatch'), listFactoryRequestsScoped: capture('factory-read-scoped'), listFactoryRequests: capture('factory-read-legacy')})
stub('../../workflows/coordinator/agent-kit-steps.ts', { beforeAgentTool: async () => {}, afterAgentTool: async () => {}, loadAgentSkill: async () => ({ error: 'notAssigned' }) })
let registry: typeof import('../../workflows/coordinator/tools')
let service: typeof import('./service')
before(async () => { registry = await import('../../workflows/coordinator/tools'); service = await import('./service') })

test('a new builtin execution retains every existing core tool from the real integration factories', () => {
  const previous = registry.coordinatorTools('synthetic-owner', null)
  assert.ok(previous.read_gmail_message, 'the existing host exposes Gmail full reads')
  const execution: AgentExecution = { id: '10000000-0000-4000-8000-000000000001', status: 'running', snapshot: makeSnapshot('10000000-0000-4000-8000-000000000002', 1, DEFAULT_AGENT_DEFINITION, 'host', { harness: 'ai_sdk', model: 'existing' }) }
  const versioned = registry.coordinatorTools('synthetic-owner', null, undefined, { execution })
  assert.deepEqual(Object.keys(versioned).sort(), [...Object.keys(previous), 'load_skill'].sort())
})


const owner = 'synthetic-owner', bot = '10000000-0000-4000-8000-000000000003'
const scope = {holder: 'synthetic-holder', turnId: 'synthetic-turn', callId: 'synthetic-call'}
const execution = (definition = DEFAULT_AGENT_DEFINITION): AgentExecution => ({id: bot, status: 'running', snapshot: makeSnapshot(bot, 1, definition, 'host', {harness: 'ai_sdk', model: 'existing'})})
const invoke = (tools: ToolSet, name: string, input: unknown) => (tools[name].execute as unknown as (input: unknown, options: {toolCallId: string; messages: []}) => Promise<unknown>)(input, {toolCallId: 'synthetic-call', messages: []})
const factoryGateKeys = ['MIKKA_ISSUE_TOOLS_ENABLED', 'MIKKA_FACTORY_ROUTING_ENABLED', 'MIKKA_FACTORY_LIFECYCLE_ENABLED'] as const
const scopedRoutingFactoryTools = ['list_factory_requests', 'intake_factory_request', 'stop_factory_task', 'get_factory_task', 'resolve_factory_task'] as const
const scopedLifecycleFactoryTools = ['dispatch_factory_task', 'recover_factory_check', 'list_factory_questions', 'answer_factory_context', 'escalate_factory_question'] as const
const knownFactoryTools = new Set<string>([...FACTORY_TOOL_IDS, ...scopedRoutingFactoryTools, ...scopedLifecycleFactoryTools])

test('all four existing flag combinations preserve the actual pre-kit catalogue for newly initialized definitions', () => {
  const keys = ['MIKKA_CLOUD_COMPUTER_TASKS', 'MIKKA_BYOS_ENABLED'] as const
  const saved = keys.map(key => process.env[key])
  try {
    for (const [computer, byos] of [['0','0'], ['0','1'], ['1','0'], ['1','1']]) {
      process.env.MIKKA_CLOUD_COMPUTER_TASKS = computer
      process.env.MIKKA_BYOS_ENABLED = byos
      const computerEnabled = computer === '1' && byos === '1'
      const defaults = service.agentKitDefaults()
      const previous = registry.coordinatorTools(owner, bot, undefined, {computerEnabled})
      const versioned = registry.coordinatorTools(owner, bot, undefined, {computerEnabled, execution: execution(defaults)})
      assert.deepEqual(Object.keys(versioned).sort(), [...Object.keys(previous), 'load_skill'].sort())
      for (const name of COMPUTER_TOOL_IDS) assert.equal(defaults.tools.includes(name), computerEnabled)
    }
    assert.equal(DEFAULT_AGENT_DEFINITION.tools.some(name => (COMPUTER_TOOL_IDS as readonly string[]).includes(name)), false)
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  }
})

test('Gmail reads retain the real input schema, host owner and native scope; account mutations still propose', async () => {
  calls.length = 0
  const tools = registry.coordinatorTools(owner, bot, scope, {execution: execution()})
  const checked = await asSchema(tools.read_gmail_message.inputSchema).validate!({message_id: 'message-1', ownerId: 'forged'})
  assert.equal(checked.success, true)
  if (!checked.success) throw Error('fixture validation failed')
  assert.deepEqual(checked.value, {message_id: 'message-1'})
  await invoke(tools, 'read_gmail_message', checked.value)
  await invoke(tools, 'send_email', {to: 'synthetic@example.invalid', subject: 'fixture', body: 'fixture'})
  assert.deepEqual(calls, [
    {name: 'read', args: [owner, 'read_gmail_message', {message_id: 'message-1'}, scope]},
    {name: 'propose', args: [owner, 'send_email', {to: 'synthetic@example.invalid', subject: 'fixture', body: 'fixture'}, scope]},
  ])
  assert.equal((await asSchema(tools.read_gmail_message.inputSchema).validate!({message_id: ''})).success, false)
})

test('explicit model account selection travels with the host owner and scope', async () => {
  calls.length = 0
  const tools = registry.coordinatorTools(owner, bot, scope, { execution: execution() })
  await invoke(tools, 'read_gmail_message', { message_id: 'message-1', account_id: 'chosen-account' })
  assert.deepEqual(calls, [{ name: 'read', args: [owner, 'read_gmail_message', { message_id: 'message-1' }, scope, 'chosen-account'] }])
})

test('conditional computer defaults keep the named Bot boundary and disabled capabilities fail closed', async () => {
  calls.length = 0
  const run = execution(builtinAgentDefinition({computerEnabled: true}))
  const tools = registry.coordinatorTools(owner, bot, scope, {execution: run, computerEnabled: true})
  assert.deepEqual(await invoke(tools, 'wake_bot_computer', {botId: '10000000-0000-4000-8000-000000000099'}), {error: 'botMismatch'})
  assert.equal(calls.length, 0)
  await invoke(tools, 'wake_bot_computer', {})
  assert.deepEqual(calls, [{name: 'wake', args: [owner, {botId: bot}, scope]}])
  assert.throws(() => registry.coordinatorTools(owner, bot, undefined, {execution: run, computerEnabled: false}), /agentToolUnavailable/)
})

test('existing custom and legacy execution snapshots never acquire new capabilities from the host defaults', () => {
  const saved = factoryGateKeys.map(key => process.env[key])
  try {
  process.env.MIKKA_FACTORY_ROUTING_ENABLED = '1'
  process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '1'
  for (const definition of [
    parseDefinition({...DEFAULT_AGENT_DEFINITION, tools: ['web_search'], instructions: 'Keep my selected profile'}),
    parseDefinition({...DEFAULT_AGENT_DEFINITION, tools: DEFAULT_AGENT_DEFINITION.tools.filter(name => name !== 'read_gmail_message')}),
  ]) {
    const run = execution(definition), before = JSON.stringify(run.snapshot)
    assert.deepEqual(importDefinition(exportDefinition(definition)), definition)
    assert.equal(run.snapshot.definitionDigest, digest(definition))
    for (const [computerEnabled, enabled] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      process.env.MIKKA_ISSUE_TOOLS_ENABLED = enabled ? '1' : '0'
      const tools = registry.coordinatorTools(owner, bot, undefined, {execution: run, computerEnabled})
      const allowedFactoryTools = new Set<string>(enabled ? [...scopedRoutingFactoryTools, ...scopedLifecycleFactoryTools] : [])
      const expected = definition.tools.filter(name =>
        (enabled || (name !== 'create_issue' && name !== 'update_issue')) &&
        (!knownFactoryTools.has(name) || allowedFactoryTools.has(name)))
      assert.deepEqual(Object.keys(tools).sort(), [...expected].sort())
    }
    assert.equal(JSON.stringify(run.snapshot), before)
  }
  } finally {
    factoryGateKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  }
})

test('Factory gates narrow frozen grants, preserve ordinary tools and keep named Bots on scoped entry points', async () => {
  const saved = factoryGateKeys.map(key => process.env[key])
  const scopedFactoryTools = new Set<string>([...scopedRoutingFactoryTools, ...scopedLifecycleFactoryTools])
  const coordinatorOnly = FACTORY_TOOL_IDS.filter(name => !scopedFactoryTools.has(name))
  const definitions = [
    parseDefinition({...DEFAULT_AGENT_DEFINITION, tools: ['web_search', 'dispatch_run']}),
    DEFAULT_AGENT_DEFINITION,
    parseDefinition({...DEFAULT_AGENT_DEFINITION, tools: [...new Set([...DEFAULT_AGENT_DEFINITION.tools, ...scopedRoutingFactoryTools, ...scopedLifecycleFactoryTools])]}),
  ]
  try {
    for (const issues of [false, true]) for (const routing of [false, true]) for (const lifecycle of [false, true]) {
      process.env.MIKKA_ISSUE_TOOLS_ENABLED = issues ? '1' : '0'
      process.env.MIKKA_FACTORY_ROUTING_ENABLED = routing ? '1' : '0'
      process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = lifecycle ? '1' : '0'
      for (const botId of [null, bot]) for (const definition of definitions) {
        calls.length = 0
        const run = execution(definition), snapshot = JSON.stringify(run.snapshot)
        const tools = registry.coordinatorTools(owner, botId, scope, {execution: run})
        const availableFactoryTools = new Set<string>(issues && routing ? [
          ...scopedRoutingFactoryTools,
          ...(lifecycle ? scopedLifecycleFactoryTools : []),
          ...(lifecycle && botId === null ? FACTORY_TOOL_IDS : []),
        ] : [])
        const expected = definition.tools.filter(name =>
          (issues || (name !== 'create_issue' && name !== 'update_issue')) &&
          (!knownFactoryTools.has(name) || availableFactoryTools.has(name)))
        assert.deepEqual(Object.keys(tools).sort(), expected.sort(), `issues=${issues}, routing=${routing}, lifecycle=${lifecycle}, bot=${botId}`)
        assert.ok(tools.web_search)
        assert.ok(tools.dispatch_run)
        for (const name of Object.keys(tools)) assert.ok(run.snapshot.effectiveTools.includes(name), `${name} was not granted by the snapshot`)
        if (botId !== null) for (const name of coordinatorOnly) assert.equal(tools[name], undefined, `${name} cannot use a builtin-only step for a named Bot`)
        if (tools.list_factory_requests) {
          await invoke(tools, 'list_factory_requests', {})
          assert.deepEqual(calls, [{name: 'factory-read-scoped', args: [owner, scope, botId]}])
        }
        assert.equal(JSON.stringify(run.snapshot), snapshot)
      }
    }
    const unknown = execution()
    unknown.snapshot.effectiveTools = [...unknown.snapshot.effectiveTools, 'unknown_factory_capability']
    assert.throws(() => registry.coordinatorTools(owner, null, scope, {execution: unknown}), /agentToolUnavailable:unknown_factory_capability/)
  } finally {
    factoryGateKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  }
})

test('new deployment defaults cannot rewrite a persisted builtin/custom head or a replayed execution', async () => {
  for (const source of ['builtin', 'user'] as const) {
    const definition = parseDefinition({...DEFAULT_AGENT_DEFINITION, tools: ['web_search'], instructions: 'Saved profile'})
    const version = {id: bot, version: 1, definition, digest: 'stored-digest', source, base_version: null}
    const saved = execution(definition), before = JSON.stringify(saved)
    const queries: string[] = []
    const client = {release() {}, async query(sql: string) {
      queries.push(sql)
      if (['begin', 'commit', 'rollback'].includes(sql)) return {rows: []}
      if (sql.startsWith('select id from "user"')) return {rows: [{id: owner}], rowCount: 1}
      if (sql.startsWith('insert into agent_kit_heads')) return {rows: []}
      if (sql.startsWith('select active_version')) return {rows: [{active_version: bot, workspace_id: null}]}
      if (sql.startsWith('select id,version,definition')) return {rows: [version]}
      if (sql.startsWith('select id,snapshot,status')) return {rows: [saved]}
      throw Error(`Unexpected write or query in persisted-profile test: ${sql}`)
    }}
    const store = new AgentKitStore({connect: async () => client} as unknown as ConstructorParameters<typeof AgentKitStore>[0])
    const actor = {ownerId: owner, botId: null, workspaceId: null}
    const currentDefaults = builtinAgentDefinition({computerEnabled: true})
    assert.deepEqual((await store.active(actor, currentDefaults)).definition, definition)
    assert.deepEqual(await store.beginExecution(actor, 'saved-turn', 'new host', async () => { throw Error('Replay must not re-resolve') }, currentDefaults), saved)
    assert.equal(JSON.stringify(saved), before)
    assert.ok(!queries.some(sql => /^(update|insert into agent_kit_versions|insert into agent_kit_executions)/.test(sql)))
  }
})


test('Factory dispatch and ordinary dispatch keep separate host entry points and frozen capability selection', async () => {
  const previous = factoryGateKeys.map(key => process.env[key])
  try {
  for (const key of factoryGateKeys) process.env[key] = '1'
  calls.length = 0
  const tools = registry.coordinatorTools(owner, null, scope, {execution: execution()})
  const ordinary = {agentId: bot, repo: 'https://github.com/synthetic-owner/synthetic-repository.git', issueId: bot}
  const factory = {agentId: bot, deviceRepoId: bot, binding: {taskId: bot, issueId: bot, attemptId: bot, revision: 1, candidateId: null}}
  assert.equal((await asSchema(tools.dispatch_run.inputSchema).validate!(ordinary)).success, true)
  assert.equal((await asSchema(tools.dispatch_run.inputSchema).validate!({agentId: bot, deviceRepoId: bot, issueId: bot})).success, false)
  await invoke(tools, 'dispatch_run', ordinary)
  await invoke(tools, 'dispatch_factory_run', factory)
  assert.deepEqual(calls, [
    {name: 'ordinary-dispatch', args: [owner, ordinary, scope, null, execution()]},
    {name: 'factory-dispatch', args: [owner, factory, scope]},
  ])
  const saved = execution(parseDefinition({...DEFAULT_AGENT_DEFINITION, tools: DEFAULT_AGENT_DEFINITION.tools.filter(name => !(FACTORY_TOOL_IDS as readonly string[]).includes(name))}))
  const snapshot = JSON.stringify(saved)
  const replayed = registry.coordinatorTools(owner, null, scope, {execution: saved})
  assert.ok(replayed.dispatch_run)
  for (const name of FACTORY_TOOL_IDS) assert.equal(replayed[name], undefined)
  assert.equal(JSON.stringify(saved), snapshot)
  } finally {
    factoryGateKeys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] })
  }
})
