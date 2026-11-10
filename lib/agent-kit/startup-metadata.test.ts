import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool, PoolClient } from 'pg'
import type { AgentExecution, AgentScope, AgentKitStore } from './store'

const owner = 'synthetic-owner', bot = '10000000-0000-4000-8000-000000000001'
const workspace = '10000000-0000-4000-8000-000000000002'
const base = 'You are the Coordinator in Mikka.\nKeep the existing rules.'
const reads: Array<{ database: 'app' | 'workspace'; sql: string; args: unknown[] }> = []
const reservations: Array<{ scope: AgentScope; key: string; instructions: string }> = []
let visible = true, active = true, name = 'Alpha', coordinator = false
let modelResolutions = 0, pluginSnapshots = 0
const forbidden = () => { throw new Error('No database connection, provider, or device in startup fixture') }

/** Actual Drizzle query construction; only its pg wire adapter is synthetic. */
function database(kind: 'app' | 'workspace') {
  const client = {
    connect: forbidden,
    async query(config: string | { text: string; rowMode?: string }, args: unknown[] = []) {
      const sql = typeof config === 'string' ? config : config.text
      reads.push({ database: kind, sql, args: [...args] })
      let row: unknown[] | null = null
      if (kind === 'app') {
        assert.match(sql, /from "bots"/)
        assert.match(sql, /"bots"\."id" = \$1/)
        assert.match(sql, /"bots"\."ownerId" = \$2/)
        assert.equal(args[2], 1)
        if (visible && args[0] === bot && args[1] === owner) {
          const projection = sql.slice(0, sql.indexOf(' from "bots"'))
          row = []
          if (projection.includes('"workspaceId"')) row.push(workspace)
          if (projection.includes('"name"')) row.push(name)
          if (projection.includes('exists (select 1 from coordinator_bots')) row.push(coordinator)
          assert.ok(row.length > 0, 'the fixture must recognize the actual selected columns')
        }
      } else {
        assert.match(sql, /from "mikka_workspace_members"/)
        assert.match(sql, /"workspaceId" = \$1/)
        assert.match(sql, /"userId" = \$2/)
        assert.match(sql, /"status" = \$3/)
        assert.deepEqual(args, [workspace, owner, 'active', 1])
        if (active) row = ['active']
      }
      assert.equal(typeof config === 'string' ? undefined : config.rowMode, 'array')
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    },
  }
  return { client, db: drizzle(client as unknown as Pool) }
}
const app = database('app'), memberships = database('workspace')
const stub = (path: string, namedExports: Record<string, unknown>) =>
  mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../db/index.ts', { db: app.db, pool: app.client })
stub('../workspace-db.ts', { workspaceDb: memberships.db, workspacePool: memberships.client })
stub('./config.ts', { agentKitEnabled: () => true })
stub('../cloud-computer-flag.ts', { cloudComputerRunsEnabled: () => false })
stub('../bot-model-selection.ts', { freezeBotModel: async (scope: AgentScope & {actorId:string}) => {
  assert.deepEqual(scope, { ownerId: owner, actorId: owner, botId: bot, workspaceId: workspace })
  modelResolutions++
  return { harness: 'ai_sdk' as const, model: 'synthetic-model', actorId: scope.actorId }
} })
stub('../subscription-runtime.ts', { authorizeSubscriptionWorkspace: forbidden, subscriptionRuntime: forbidden })
stub('../coordinator/instructions.ts', { COORDINATOR_INSTRUCTIONS: base })
stub('../coordinator/native-prompt.ts', { personalCoordinatorInstructions: () => base })
stub('../plugins/runtime.ts', { personalPlugins: { snapshot: async () => {
  pluginSnapshots++; return { servers: [], skills: [] }
} } })
stub('../../workflows/coordinator/tool-scope.ts', { assertNativeToolScope: forbidden })

let service: typeof import('./service')
let steps: typeof import('../../workflows/coordinator/agent-kit-steps')
before(async () => {
  service = await import('./service')
  const reserve: AgentKitStore['beginExecution'] = async (scope, key, instructions, runtime, defaults, plugins) => {
    reservations.push({ scope: { ...scope }, key, instructions })
    const resolved = typeof runtime === 'function' ? await runtime(defaults) : runtime
    if (plugins) await plugins({} as PoolClient)
    return { id: '10000000-0000-4000-8000-000000000003',
      snapshot: { runtime: resolved } as AgentExecution['snapshot'], status: 'running' }
  }
  mock.method(service.agentKitStore, 'beginExecution', reserve)
  steps = await import('../../workflows/coordinator/agent-kit-steps')
})
beforeEach(() => {
  reads.length = 0; reservations.length = 0
  visible = true; active = true; name = 'Alpha'; coordinator = false
  modelResolutions = 0; pluginSnapshots = 0
})
const begin = (user = owner, enabled = true) =>
  steps.beginPreparedAgentExecution(user, bot, 'synthetic-workflow', 2, { harness: 'ai_sdk' }, enabled)
function counts(branch: string) {
  const value = { branch, app: reads.filter(row => row.database === 'app').length,
    workspace: reads.filter(row => row.database === 'workspace').length,
    reservations: reservations.length, modelResolutions, pluginSnapshots }
  console.info(JSON.stringify({ fixture: 'startup_query_counts', ...value }))
  return value
}
function expectedInstructions(botName: string) {
  return base.replace('You are the Coordinator in Mikka', 'You are ' + botName + ", one of the person's bots in Mikka") +
    '\n\nYour name is ' + botName + '. The person named you; answer to it and never call yourself the Coordinator. The Coordinator is another of their bots with its own chat.'
}

test('hosted startup reads one owned bot projection and fresh membership before reservation', async () => {
  await begin()
  const result = counts('hosted-success')
  assert.deepEqual(reservations[0], { scope: { ownerId: owner, botId: bot, workspaceId: workspace },
    key: 'synthetic-workflow:2', instructions: expectedInstructions('Alpha') })
  assert.equal(modelResolutions, 1)
  assert.equal(pluginSnapshots, 1)
  assert.equal(result.app, 1, 'hosted startup must not reread the same owned bot for instructions')
  assert.equal(result.workspace, 1)
})

test('coordinator instructions retain the original exact base', async () => {
  coordinator = true
  await begin()
  assert.equal(reservations[0].instructions, base)
  counts('coordinator-success')
})

test('missing and foreign-owner bots fail before any membership or reservation', async () => {
  visible = false
  await assert.rejects(begin(), /agentScopeNotFound/)
  assert.equal(reads.length, 1)
  assert.equal(reads[0].database, 'app')
  assert.equal(reservations.length, 0)
  counts('missing-bot')
  reads.length = 0; visible = true
  await assert.rejects(begin('foreign-owner'), /agentScopeNotFound/)
  assert.equal(reads.length, 1)
  assert.equal(reads[0].database, 'app')
  assert.equal(reservations.length, 0)
  assert.equal(modelResolutions, 0)
  counts('foreign-owner')
})

test('inactive membership fails after the fresh scope lookup without reservation', async () => {
  active = false
  await assert.rejects(begin(), /agentScopeNotFound/)
  assert.deepEqual(reads.map(row => row.database), ['app', 'workspace'])
  assert.equal(reservations.length, 0)
  assert.equal(modelResolutions, 0)
  counts('inactive-membership')
})

test('another invocation rereads current metadata and revoked membership', async () => {
  await begin()
  assert.equal(reservations[0].instructions, expectedInstructions('Alpha'))
  name = 'Renamed'
  await begin()
  assert.equal(reservations[1].instructions, expectedInstructions('Renamed'))
  active = false
  const before = reads.length
  await assert.rejects(begin(), /agentScopeNotFound/)
  assert.deepEqual(reads.slice(before).map(row => row.database), ['app', 'workspace'])
  assert.equal(reservations.length, 2)
  counts('two-fresh-invocations-then-revoked')
})

test('disabled prepared entry performs no metadata, membership, or reservation reads', async () => {
  assert.equal(await begin(owner, false), null)
  assert.equal(reads.length, 0)
  assert.equal(reservations.length, 0)
  assert.equal(modelResolutions, 0)
  counts('disabled')
})

test('native reservation retains its existing separate scope and instruction reads', async () => {
  await steps.beginAgentExecution(owner, bot, 'native-workflow', 1, { harness: 'codex', deviceId: bot })
  assert.deepEqual(reads.map(row => row.database), ['app', 'workspace', 'app'])
  assert.equal(reservations[0].instructions, expectedInstructions('Alpha'))
  assert.equal(modelResolutions, 0)
  assert.equal(pluginSnapshots, 1)
  counts('native-unchanged')
})

test('the old agentScope client interface retains its locking and membership SQL', async () => {
  const local: Array<{ sql: string; args: unknown[] }> = []
  const appClient = { query: async (sql: string, args: unknown[]) => {
    local.push({ sql, args }); return { rows: [{ workspaceId: workspace }] }
  } }
  const workspaceClient = { query: async (sql: string, args: unknown[]) => {
    local.push({ sql, args }); return { rows: [{ status: 'active' }] }
  } }
  const result = await service.agentScope(owner, bot,
    appClient as unknown as Pick<PoolClient, 'query'>,
    workspaceClient as unknown as Pick<PoolClient, 'query'>)
  assert.deepEqual(result, { ownerId: owner, botId: bot, workspaceId: workspace })
  assert.equal(reads.length, 0)
  assert.deepEqual(local, [
    { sql: 'select "workspaceId" from bots where id=$1 and "ownerId"=$2 for share', args: [bot, owner] },
    { sql: 'select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2 and status=\'active\'', args: [workspace, owner] },
  ])
  console.info(JSON.stringify({ fixture: 'startup_query_counts', branch: 'legacy-explicit-clients', app: 1, workspace: 1, reservations: 0 }))
})
