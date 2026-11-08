import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import type { Pool } from 'pg'
import type { OrderEntry } from '../model-order-plan'
import { agentProfileDigest, agentProfileInstructions, builtinAgentProfileSelection, parseAgentProfile, type AgentProfileSelection } from './agent-profile-definition'

// This is a query-boundary test, not a PostgreSQL emulator. Real SQL predicates,
// row locks and membership commit fences are covered by agent-profile.db.test.ts.
const memberships: string[] = []
const inactive = new Set<string>()
let providerCalls = 0
mock.method(globalThis, 'fetch', async () => { providerCalls++; throw new Error('unexpected provider HTTP') })
mock.module(new URL('../subscription-runtime.ts', import.meta.url).href, { namedExports: {
  authorizeSubscriptionWorkspace: async (ownerId: string) => {
    memberships.push(ownerId)
    if (inactive.has(ownerId)) throw new Error('workspaceAccessDenied')
  },
  authorizeSubscriptionUse: () => assert.fail('target validation must not prepare a provider'),
  subscriptionRuntime: () => { providerCalls++; throw new Error('unexpected provider access') },
} })
mock.module(new URL('../rule-dispatch.ts', import.meta.url).href, { namedExports: { cloudReady: async () => true } })
mock.module(new URL('../cloud-template-models.ts', import.meta.url).href, { namedExports: { cloudModelSupport: () => 'ready' } })
const scope = { ownerId: 'requester', workspaceId: randomUUID() }
const resourcePolicySql = "select w.kind,l.\"organizationId\",p.\"modelCredentialSharing\",p.\"mcpSharing\",p.\"allowedModelProviders\" from mikka_workspaces w left join mikka_organization_workspaces l on l.\"workspaceId\"=w.id left join mikka_organization_resource_policies p on p.\"organizationId\"=l.\"organizationId\" where w.id=$1"
const unexpectedWorkspace = () => { throw new Error('Unexpected Workspace operation in fixed-target fixture') }
mock.module(new URL('../workspace-db.ts', import.meta.url).href, { namedExports: {
  workspaceDb: { select: unexpectedWorkspace, transaction: unexpectedWorkspace },
  workspacePool: { query: async (sql: string, params: unknown[]) => {
    assert.equal(sql.replace(/\s+/g, ' ').trim(), resourcePolicySql)
    assert.deepEqual(params, [scope.workspaceId])
    // Only this known non-Org Team is modeled. Production resource policy
    // remains in the call graph; other statements and tenants fail loudly.
    return { rows: [{ kind: 'team', organizationId: null, modelCredentialSharing: null, mcpSharing: null, allowedModelProviders: null }], rowCount: 1 }
  } },
} })
const { assertFrozenModelTarget, assertProfileTarget, assertProfileSelection } = await import('./agent-profile')
const { resolveModelDispatch } = await import('../model-dispatch')

type Connection = { id: string; ownerId: string; provider: 'claude' | 'codex'; models: string[]; state: string; paused: boolean; removed: boolean; epoch: string; bindingEpoch: string; quota: unknown }
type Key = { id: string; ownerId: string; provider: 'custom' | 'deepseek'; name: null; baseUrl: string; protocol: 'openai' | 'anthropic'; last4: string; models: string[]; modelsError: string | null; responsesApi: boolean }
type Call = { kind: string; params: unknown[]; rows: number }
const quota = (used = .1, age = 0) => ({ vendor: 'codex', source: 'official', status: 'ok', plan: null, observedAt: new Date(Date.now() - age).toISOString(), windows: [{ kind: 'five_hour', used, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] })
function fixture() {
  const connection = (ownerId: string): Connection => ({ id: randomUUID(), ownerId, provider: 'codex', models: ['fixed-model', 'other-model'], state: 'connected', paused: false, removed: false, epoch: '1', bindingEpoch: '1', quota: quota() })
  const key = (ownerId: string): Key => ({ id: randomUUID(), ownerId, provider: 'deepseek', name: null, baseUrl: 'https://example.invalid', protocol: 'openai', last4: 'fake', models: ['fixed-model', 'other-model'], modelsError: null, responsesApi: true })
  const connections = [connection(scope.ownerId), connection(scope.ownerId), connection('payor'), connection('unrelated-payor')]
  const keys = [key(scope.ownerId), key(scope.ownerId), key('payor'), key('unrelated-payor')]
  const shares = new Set(['payor', 'unrelated-payor']), keyShares = new Set(keys.filter(row => row.ownerId !== scope.ownerId).map(row => row.id))
  const calls: Call[] = []
  let allowed = true, health: unknown[] = [], afterLock: (() => void) | undefined, profile: AgentProfileSelection | undefined
  let profileState: { archivedAt?: Date; enabled?: boolean; version?: number; ownerId?: string; workspaceId?: string } = {}
  const mayUse = (owner: string) => owner === scope.ownerId || (allowed && shares.has(owner))
  const mayUseKey = (row: Key) => row.ownerId === scope.ownerId || (allowed && keyShares.has(row.id))
  const query = async (sql: string, params: unknown[] = []) => {
    let kind: string, rows: unknown[]
    if (sql.includes('FROM model_order_settings')) {
      kind = 'settings'; rows = [{ location: 'cloud', customized: false, preferredHarness: 'codex', autoModelRouting: false }]
    } else if (sql.includes('FROM factory_agent_profiles')) {
      kind = 'profile_lock'
      rows = profile && params[0] === profile.profileId && params[1] === (profileState.ownerId ?? scope.ownerId) && params[2] === (profileState.workspaceId ?? scope.workspaceId)
        ? [{ id: profile.profileId, ownerId: scope.ownerId, workspaceId: scope.workspaceId, version: profileState.version ?? profile.version, definition: { ...profile.definition, enabled: profileState.enabled ?? true }, digest: profile.digest, archivedAt: profileState.archivedAt ?? null }] : []
    } else if (sql.includes('WITH choices AS')) {
      kind = 'catalogue'
      rows = connections.filter(row => row.ownerId === params[0] && row.state === 'connected' && !row.paused && !row.removed && row.epoch === row.bindingEpoch)
        .flatMap(row => row.models.map(model => ({ ownerId: row.ownerId, modelId: model, connectionId: row.id, provider: row.provider, _preferred: true, _at: new Date().toISOString(), _id: randomUUID() })))
        .filter(row => params.length === 6 || (row.connectionId === params[6] && row.modelId === params[7]))
    } else if (sql.startsWith('SELECT c."ownerId" FROM byos_connections c')) {
      kind = 'selected_owner'
      rows = connections.filter(row => row.id === params[0] && mayUse(row.ownerId)).map(row => ({ ownerId: row.ownerId }))
    } else if (sql.includes('"modelCatalog"->\'models\' AS models')) {
      kind = 'catalogue_rank'
      rows = connections.filter(row => (params[0] as string[]).includes(row.id)).map(row => ({ id: row.id, models: row.models }))
    } else if (sql.startsWith('SELECT subscriptions FROM workspace_personal_policies')) {
      kind = 'share_policy'; rows = [{ subscriptions: allowed }]
    } else if (sql.startsWith('SELECT "ownerId" FROM workspace_subscription_shares')) {
      kind = 'pooled_owners'; rows = [...shares].map(ownerId => ({ ownerId }))
    } else if (sql.startsWith('SELECT CASE WHEN sh."allowOthers" THEN NOT EXISTS')) {
      kind = 'fresh_share'; rows = [{ allowOthers: allowed && shares.has(String(params[0])) }]
    } else if (sql.startsWith('SELECT id FROM byos_connections') || sql.startsWith('SELECT id FROM model_api_keys')) {
      kind = 'source_lock'; rows = [{ id: params[0] }]; afterLock?.()
    } else if (sql.includes('FROM byos_connections c JOIN unnest')) {
      kind = 'connection_state'; rows = connections.filter(row => (params[0] as string[]).includes(row.id) && (params[1] as string[]).includes(row.ownerId))
    } else if (sql.includes('WITH requested AS')) {
      kind = 'provider_health'; rows = health
    } else if (sql.includes('FROM model_api_keys k') && sql.includes('JOIN unnest')) {
      kind = 'key_state'; rows = keys.filter(row => (params[0] as string[]).includes(row.id) && (params[1] as string[]).includes(row.ownerId) && mayUseKey(row))
    } else if (sql.includes('FROM model_api_key_shares s JOIN model_api_keys k')) {
      kind = 'shared_keys'; rows = keys.filter(row => row.ownerId !== scope.ownerId && keyShares.has(row.id) && (params.length === 2 || row.id === params[2]))
    } else if (sql.includes('FROM model_api_keys WHERE "ownerId"=$1')) {
      kind = 'own_keys'; rows = keys.filter(row => row.ownerId === params[0] && (params.length === 1 || row.id === params[1]))
    } else assert.fail(`Unrecognized query: ${sql}`)
    calls.push({ kind, params: structuredClone(params), rows: rows.length })
    return { rows, rowCount: rows.length }
  }
  const source = (kind: 'subscription' | 'api_key', shared = false): OrderEntry => ({ id: randomUUID(), harness: 'codex', model: 'fixed-model', source: kind === 'subscription' ? { kind, connectionId: connections[shared ? 2 : 0].id } : { kind, keyId: keys[shared ? 2 : 0].id } })
  const selection = (entry: OrderEntry): AgentProfileSelection => {
    const definition = parseAgentProfile({ name: 'Fixed target fixture', harness: entry.harness, model: { mode: 'fixed', harness: entry.harness, model: entry.model, source: entry.source } })
    profile = { profileId: randomUUID(), version: 1, digest: agentProfileDigest(definition, []), name: definition.name, source: 'explicit', reason: 'explicit', scope, definition, skills: [], instructions: agentProfileInstructions(definition, []), targetEntry: entry }
    return profile
  }
  return { query: { query } as unknown as Pick<Pool, 'query'>, calls, connections, keys, shares, keyShares, source, selection,
    policy(value: boolean) { allowed = value }, health(value: unknown[]) { health = value }, afterLock(value: () => void) { afterLock = value }, profileState(value: typeof profileState) { profileState = value } }
}
const result = async (fn: () => Promise<void>) => {
  try { await fn(); return { ok: true } } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) throw error
    return { code: error.code, detail: 'detail' in error ? error.detail : undefined }
  }
}
const reset = () => { memberships.length = 0; inactive.clear(); providerCalls = 0 }

for (const shared of [false, true]) test(`fixed ${shared ? 'shared' : 'own'} dispatch avoids unrelated sources while retaining fresh credential refusal`, async () => {
  reset()
  const f = fixture(), entry = f.source('subscription', shared)
  assert.ok(entry.source.kind === 'subscription')
  const connectionId = entry.source.connectionId
  const resolve = () => resolveModelDispatch(f.query as Pool, { ...scope, botId: null }, undefined, 'cloud', undefined,
    { exactEntry: entry, bindSubscription: false, skipCatalogueRefresh: true, probeQuota: false })
  const selected = await resolve()
  assert.equal(selected.kind, 'cloud')
  assert.deepEqual(selected.entry, entry)
  assert.equal(f.calls.some(call => ['pooled_owners', 'catalogue_rank', 'own_keys', 'shared_keys'].includes(call.kind)), false)
  assert.equal(f.calls.filter(call => call.kind === 'catalogue').length, 1)
  assert.ok(f.calls.filter(call => call.kind === 'catalogue').every(call => call.params[6] === connectionId && call.params[7] === entry.model))
  f.connections[shared ? 2 : 0].paused = true
  assert.equal((await resolve()).kind, 'none', 'the next call cannot reuse the prior positive source snapshot')
  assert.equal(providerCalls, 0)
})

test('a harness-only dispatch keeps its preference model even with a conflicting exact source', async () => {
  reset()
  const f = fixture(), entry = { ...f.source('subscription'), model: 'other-model' }
  const resolved = await resolveModelDispatch(f.query as Pool, { ...scope, botId: null }, { harness: 'codex' }, 'cloud', undefined,
    { exactEntry: entry, bindSubscription: false, skipCatalogueRefresh: true, probeQuota: false })
  assert.equal(resolved.kind, 'none')
  if (resolved.kind === 'none') assert.equal(resolved.reason, 'notOffered')
  assert.ok(f.calls.some(call => call.kind === 'pooled_owners'))
  assert.equal(providerCalls, 0)
})

for (const shared of [false, true]) for (const kind of ['subscription', 'api_key'] as const) test(`fixed ${shared ? 'shared' : 'own'} ${kind} reads only its selected source, with the original final fences`, async t => {
  reset()
  const f = fixture(), entry = f.source(kind, shared), selected = f.selection(entry)
  const baseline = await result(() => assertFrozenModelTarget(f.query, scope, entry))
  const originalCalls = f.calls.splice(0), originalMemberships = memberships.splice(0)
  assert.deepEqual(baseline, { ok: true })
  assert.deepEqual(await result(() => assertProfileTarget(f.query, scope, selected)), baseline)
  const finalFences = (calls: Call[]) => calls.filter(call => ['source_lock', 'fresh_share', 'connection_state', 'key_state', 'provider_health'].includes(call.kind))
  assert.deepEqual(finalFences(f.calls), finalFences(originalCalls), 'same source lock, fresh shared authorization, state and health reads')
  assert.equal(providerCalls, 0)
  assert.ok(f.calls.length < originalCalls.length, 'a frozen fixed target avoids the full catalogue round trips')
  if (kind === 'subscription') {
    assert.equal(f.calls.some(call => call.kind.endsWith('_keys') || call.kind === 'catalogue_rank'), false)
    assert.deepEqual(f.calls.filter(call => call.kind === 'catalogue').map(call => [call.params[0], call.rows]), [[shared ? 'payor' : scope.ownerId, 1]])
    assert.deepEqual(memberships, shared ? ['payor'] : [])
  } else {
    assert.equal(f.calls.some(call => call.kind === 'catalogue' || call.kind === 'pooled_owners'), false)
    assert.equal(f.calls.filter(call => call.kind.endsWith('_keys')).reduce((sum, call) => sum + call.rows, 0), 1)
    assert.deepEqual(memberships, [])
  }
  t.diagnostic(JSON.stringify({ kind, shared, originalQueries: originalCalls.length, selectedQueries: f.calls.length, originalMembershipChecks: originalMemberships.length, selectedMembershipChecks: memberships.length, providerCalls }))
})

for (const scenario of ['paused', 'removed', 'reconnect', 'epoch_changed', 'model_gone', 'quota', 'stale_quota', 'share_revoked', 'team_denied', 'payor_left', 'health'] as const) test(`fixed subscription keeps the full implementation refusal: ${scenario}`, async () => {
  reset()
  const f = fixture(), shared = ['share_revoked', 'team_denied', 'payor_left'].includes(scenario), entry = f.source('subscription', shared), selected = f.selection(entry), connection = f.connections[shared ? 2 : 0]
  if (scenario === 'paused') connection.paused = true
  if (scenario === 'removed') connection.removed = true
  if (scenario === 'reconnect') connection.state = 'reconnect_required'
  if (scenario === 'epoch_changed') connection.epoch = '2'
  if (scenario === 'model_gone') connection.models = ['other-model']
  if (scenario === 'quota') connection.quota = quota(1)
  if (scenario === 'stale_quota') connection.quota = quota(.1, 300_000)
  if (scenario === 'share_revoked') f.shares.delete('payor')
  if (scenario === 'team_denied') f.policy(false)
  if (scenario === 'payor_left') inactive.add('payor')
  if (scenario === 'health') f.health([{ kind: 'subscription', id: connection.id, harness: null, model: null, failure: { kind: 'balance', retryable: false, status: 402 }, observedAt: new Date() }])
  const baseline = await result(() => assertFrozenModelTarget(f.query, scope, entry))
  assert.equal(baseline.code, 'agentProfileModelUnavailable')
  assert.deepEqual(await result(() => assertProfileTarget(f.query, scope, selected)), baseline)
  assert.equal(providerCalls, 0)
})

for (const scenario of ['unshared', 'team_denied', 'models_error', 'model_gone', 'protocol', 'responses', 'health'] as const) test(`fixed API key keeps the full implementation refusal: ${scenario}`, async () => {
  reset()
  const f = fixture(), shared = ['unshared', 'team_denied'].includes(scenario), entry = f.source('api_key', shared), selected = f.selection(entry), key = f.keys[shared ? 2 : 0]
  if (scenario === 'unshared') f.keyShares.delete(key.id)
  if (scenario === 'team_denied') f.policy(false)
  if (scenario === 'models_error') key.modelsError = 'invalid'
  if (scenario === 'model_gone') key.models = ['other-model']
  if (scenario === 'protocol') { key.provider = 'custom'; key.protocol = 'anthropic' }
  if (scenario === 'responses') key.responsesApi = false
  if (scenario === 'health') f.health([{ kind: 'api_key', id: key.id, harness: null, model: null, failure: { kind: 'auth', retryable: false, status: 401 }, observedAt: new Date() }])
  const baseline = await result(() => assertFrozenModelTarget(f.query, scope, entry))
  assert.equal(baseline.code, 'agentProfileModelUnavailable')
  assert.deepEqual(await result(() => assertProfileTarget(f.query, scope, selected)), baseline)
  assert.equal(providerCalls, 0)
})

for (const change of ['pause', 'share', 'key_share'] as const) test(`the original post-lock fresh read still sees ${change}`, async () => {
  reset()
  const run = async (full: boolean) => {
    const f = fixture(), entry = f.source(change === 'key_share' ? 'api_key' : 'subscription', change !== 'pause'), selected = f.selection(entry)
    f.afterLock(() => { if (change === 'pause') f.connections[0].paused = true; else if (change === 'share') f.shares.delete('payor'); else f.keyShares.clear() })
    return result(() => full ? assertFrozenModelTarget(f.query, scope, entry) : assertProfileTarget(f.query, scope, selected))
  }
  const baseline = await run(true)
  assert.equal(baseline.code, 'agentProfileModelUnavailable')
  assert.deepEqual(await run(false), baseline)
})

for (const mode of ['builtin', 'inherit'] as const) test(`${mode} target retains the complete catalogue and its ordering path`, async () => {
  reset()
  const f = fixture(), entry = f.source('subscription'), selected = mode === 'builtin' ? builtinAgentProfileSelection(scope, entry) : f.selection(entry)
  if (mode === 'inherit') selected.definition = { ...selected.definition, model: { mode: 'inherit' } }
  await assertFrozenModelTarget(f.query, scope, entry)
  const originalCalls = f.calls.splice(0), originalMemberships = memberships.splice(0)
  await assertProfileTarget(f.query, scope, selected)
  assert.deepEqual(f.calls, originalCalls)
  assert.deepEqual(memberships, originalMemberships)
})

for (const change of ['archived', 'disabled', 'revision', 'owner', 'workspace', 'definition', 'pin'] as const) test(`fixed Profile admission still refuses ${change} before reading its source`, async () => {
  reset()
  const f = fixture(), selected = f.selection(f.source('subscription'))
  if (change === 'archived') f.profileState({ archivedAt: new Date() })
  if (change === 'disabled') f.profileState({ enabled: false })
  if (change === 'revision') f.profileState({ version: 2 })
  if (change === 'owner') f.profileState({ ownerId: 'other' })
  if (change === 'workspace') f.profileState({ workspaceId: randomUUID() })
  if (change === 'definition') selected.name = 'forged'
  if (change === 'pin') selected.targetEntry = { ...selected.targetEntry, model: 'other-model' }
  const outcome = await result(() => assertProfileSelection(f.query, scope, selected))
  assert.equal(outcome.code, ({ archived: 'agentProfileArchived', disabled: 'agentProfileDisabled', revision: 'agentProfileVersionConflict', owner: 'agentProfileNotFound', workspace: 'agentProfileNotFound', definition: 'agentProfileSelectionInvalid', pin: 'agentProfilePinConflict' })[change])
  assert.deepEqual(f.calls.map(call => call.kind), ['profile_lock'])
  assert.equal(providerCalls, 0)
})
