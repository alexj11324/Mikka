import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import type { OrderScope, OrderView } from './model-order'
import type { PoolDevice } from './model-order-plan'

type Trace = { sql: string; args: unknown[] }
type FixtureQuery = ReturnType<typeof fixture>
const unused = () => { throw new Error('unexpected external effect in order projection test') }
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('./execution-settings.ts', { ExecutionSettings: class {
  constructor(readonly query: FixtureQuery) {}
  async modelCandidates(scope: OrderScope) {
    assert.equal(scope.ownerId, this.query.scope.ownerId)
    assert.equal(scope.workspaceId, this.query.scope.workspaceId)
    if (this.query.failCandidates) throw this.query.failure
    return [{ ownerId: scope.ownerId, connectionId: this.query.connectionId, provider: 'claude', modelId: 'claude-haiku-5-5' }]
  }
} })
stub('./subscription-runtime.ts', { authorizeSubscriptionWorkspace: unused })
stub('./device-presence.ts', { deviceOnlineStates: unused })
stub('./cloud-template-models.ts', { cloudModelSupport: () => 'ready' })
stub('./execution-identity.ts', { executionMembersActive: unused, revalidateExecutionIdentity: unused, ExecutionIdentityError: class extends Error {} })
stub('./model-api-key-runs.ts', { stopRunsUsingApiKeys: unused })
stub('./secrets/crypto.ts', { openSecret: unused, sealSecret: unused, SecretsKeyMissingError: class extends Error {} })
stub('./live/panels.ts', { runChanged: unused })
stub('./live/lists.ts', { runListChanged: unused })
stub('./device-gateway-notify.ts', { runControlChanged: unused })
stub('./due-timer.ts', { armDueTimerAfterCommit: unused })

const policyWorkspaces = new Set<string>()
const resourcePolicySql = "select w.kind,l.\"organizationId\",p.\"modelCredentialSharing\",p.\"mcpSharing\",p.\"allowedModelProviders\" from mikka_workspaces w left join mikka_organization_workspaces l on l.\"workspaceId\"=w.id left join mikka_organization_resource_policies p on p.\"organizationId\"=l.\"organizationId\" where w.id=$1"
stub('./workspace-db.ts', {
  workspaceDb: { select: unused, transaction: unused },
  workspacePool: { query: async (sql: string, args: unknown[]) => {
    if (sql.includes("SELECT to_jsonb(p)->'modelPolicy'")) { assert.ok(policyWorkspaces.has(String(args[0]))); return { rows: [], rowCount: 0 } }
    if (sql.includes('FROM mikka_organization_workspaces l JOIN mikka_organizations')) { assert.ok(policyWorkspaces.has(String(args[0]))); return { rows: [], rowCount: 0 } }
    assert.equal(sql.replace(/\s+/g, ' ').trim(), resourcePolicySql)
    assert.ok(args.length === 1 && typeof args[0] === 'string' && policyWorkspaces.has(args[0]), 'resource policy is scoped to a Workspace created by this fixture')
    // The existing trace measures the injected APP executor; the separate
    // WS executor accepts only this exact current non-Org linkage read.
    return { rows: [{ kind: 'team', organizationId: null, modelCredentialSharing: null, mcpSharing: null, allowedModelProviders: null }], rowCount: 1 }
  } },
})

function fixture(allowed: boolean, ownerId = 'owner-a') {
  const scope = { ownerId, workspaceId: `workspace-${ownerId}` }
  policyWorkspaces.add(scope.workspaceId)
  const connectionId = `connection-${ownerId}`
  const key = { id: `key-${ownerId}`, ownerId, provider: 'deepseek', name: null, baseUrl: 'https://example.invalid', protocol: 'openai', last4: 'test', models: ['deepseek-flash'], modelsError: null, responsesApi: false }
  const quota = { vendor: 'claude_code', source: 'official', status: 'ok', plan: null, observedAt: new Date(Date.now() - 1000).toISOString(), windows: [{ kind: 'five_hour', used: 0.1, resetsAt: new Date(Date.now() + 3600000).toISOString() }] }
  const trace: Trace[] = []
  const failure = new Error('synthetic query refusal')
  const state = { scope, connectionId, trace, failure, paused: false, failCandidates: false, failStates: false, failCount: false,
    async query(sql: string, args: unknown[] = []) {
      trace.push({ sql, args: structuredClone(args) })
      if (sql.startsWith('SELECT subscriptions FROM workspace_personal_policies')) {
        assert.deepEqual(args, [scope.workspaceId]); return { rows: [{ subscriptions: allowed }] }
      }
      if (sql.startsWith('SELECT "ownerId" FROM workspace_subscription_shares')) {
        assert.deepEqual(args, [scope.workspaceId, scope.ownerId]); return { rows: [] }
      }
      if (sql.startsWith('SELECT id::text AS id,"modelCatalog"')) return { rows: [{ id: connectionId, models: ['claude-haiku-5-5'] }] }
      if (sql.includes('FROM model_api_keys WHERE "ownerId"=$1')) {
        assert.deepEqual(args, [scope.ownerId]); return { rows: [key] }
      }
      if (sql.includes('FROM model_api_key_shares s JOIN model_api_keys k')) {
        assert.deepEqual(args, [scope.workspaceId, scope.ownerId]); return { rows: [] }
      }
      if (sql.includes('FROM model_order_settings')) return { rows: [{ location: 'local', customized: false, preferredHarness: 'claude_code', autoModelRouting: true }] }
      if (sql.startsWith('SELECT c.id::text AS id,c."ownerId"')) {
        if (state.failStates) throw failure
        return { rows: [{ id: connectionId, ownerId, state: 'connected', paused: state.paused, removed: false, provider: 'claude', epoch: '1', quota }] }
      }
      if (sql.startsWith('SELECT k.id::text AS id,k."modelsError"')) return { rows: [{ id: key.id, modelsError: null, provider: key.provider }] }
      if (sql.trimStart().startsWith('WITH requested AS')) return { rows: [] }
      if (sql.startsWith('SELECT id::text AS id FROM byos_connections WHERE')) {
        assert.deepEqual(args, [scope.ownerId])
        if (state.failCount) throw failure
        return { rows: [{ id: connectionId }] }
      }
      throw new Error(`unexpected fixture query: ${sql}`)
    },
  }
  return state
}

const devices: PoolDevice[] = []
let orderView: typeof import('./model-order').orderView
before(async () => {
  mock.method(globalThis, 'fetch', unused)
  ;({ orderView } = await import('./model-order'))
})
const queryType = (query: FixtureQuery) => query as unknown as Parameters<typeof orderView>[0]
// The old implementation accepts and ignores a fourth JS argument, so this
// regression demonstrates the real redundant reads before the overload exists.
const context = (query: FixtureQuery) => Reflect.apply(orderView, undefined, [queryType(query), query.scope, async () => devices, 'context']) as Promise<Partial<OrderView>>
const fields = (view: Partial<OrderView>) => ({ location: view.location, preferredHarness: view.preferredHarness, entries: view.entries, candidates: view.candidates, cloudReady: view.cloudReady, cloudModels: view.cloudModels })

for (const allowed of [false, true]) test(`prompt projection skips only unused credential counts when sharing is ${allowed}`, async t => {
  const fullQuery = fixture(allowed), promptQuery = fixture(allowed)
  const full = await orderView(queryType(fullQuery), fullQuery.scope, async () => devices)
  const prompt = await context(promptQuery)
  // The full view counts connected subscriptions and the own/shared key rows.
  // Empty shared-key candidates no longer issue an unused policy read.
  const saved = 3
  t.diagnostic(JSON.stringify({ kind: 'order_projection_query_budget', allowed, full: fullQuery.trace.length, context: promptQuery.trace.length, saved: fullQuery.trace.length - promptQuery.trace.length }))
  assert.equal(fullQuery.trace.length - promptQuery.trace.length, saved, 'prompt_unused_count_queries_remain')
  assert.deepEqual(prompt, fields(full), 'the prompt consumes the exact same model and credential-state projection')
  assert.equal(full.credentials, 2, 'the public settings response still counts both connected credentials')
  assert.equal(Object.hasOwn(prompt, 'credentials'), false, 'a missing count is never a fabricated zero')
  const countStart = fullQuery.trace.findIndex(row => row.sql.startsWith('SELECT id::text AS id FROM byos_connections WHERE'))
  assert.ok(countStart >= 0)
  assert.deepEqual(promptQuery.trace, [...fullQuery.trace.slice(0, countStart), ...fullQuery.trace.slice(countStart + saved)], 'all required queries and scoped arguments remain in their original order')
})

test('an unused count failure cannot discard prompt facts, while the full view still reports it', async () => {
  const query = fixture(true); query.failCount = true
  await assert.rejects(orderView(queryType(query), query.scope, async () => devices), error => error === query.failure)
  query.trace.length = 0
  const projected = await context(query)
  assert.ok(projected.entries?.length)
  assert.equal(query.trace.some(row => row.sql.startsWith('SELECT id::text AS id FROM byos_connections WHERE')), false)
})

for (const phase of ['failCandidates', 'failStates'] as const) test(`the prompt still rejects a required ${phase} check`, async () => {
  const query = fixture(true); query[phase] = true
  await assert.rejects(context(query), error => error === query.failure)
  assert.equal(query.trace.some(row => row.sql.startsWith('SELECT id::text AS id FROM byos_connections WHERE')), false)
})

test('new prompt reads observe paused credentials and keep concurrent owners separate', async () => {
  const alice = fixture(true, 'alice'), bob = fixture(false, 'bob')
  const [one, other] = await Promise.all([context(alice), context(bob)])
  assert.ok(one.candidates?.every(row => row.source.kind !== 'subscription' || row.source.connectionId === alice.connectionId))
  assert.ok(other.candidates?.every(row => row.source.kind !== 'subscription' || row.source.connectionId === bob.connectionId))
  alice.paused = true
  const next = await context(alice)
  assert.equal(one.entries?.find(row => row.source.kind === 'subscription')?.block?.reason, 'noDevice')
  assert.equal(next.entries?.find(row => row.source.kind === 'subscription')?.block?.reason, 'paused')
})
