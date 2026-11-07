import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { beforeEach, mock, test } from 'node:test'
import type { Pool } from 'pg'
import { BUILTIN_AGENT_PROFILE_ID, agentProfileDigest, agentProfileInstructions, builtinAgentProfileSelection, parseAgentProfile, type AgentProfileSelection } from './agent-profile-definition'

const actor = { userId: 'requester', workspaceId: randomUUID() }
const scope = { ownerId: actor.userId, workspaceId: actor.workspaceId }
const runId = randomUUID(), deviceId = randomUUID(), bindingId = randomUUID(), agentId = randomUUID(), connectionId = randomUUID()
const entry = { id: randomUUID(), harness: 'codex' as const, model: 'fixture-model', source: { kind: 'subscription' as const, connectionId } }
const definition = parseAgentProfile({ name: 'Quota fixture', harness: 'codex', model: { mode: 'fixed', harness: entry.harness, model: entry.model, source: entry.source } })
const selected: AgentProfileSelection = { profileId: randomUUID(), version: 1, digest: agentProfileDigest(definition, []), name: definition.name,
  source: 'explicit', reason: 'explicit', scope, definition, skills: [], instructions: agentProfileInstructions(definition, []), targetEntry: entry }
const candidates = [{ ...entry, name: entry.model, provider: 'codex', credentialOwnerId: 'payor' }]
const calls: string[] = []
let selection = structuredClone(selected), bindingAvailable = true, identityAvailable = true
let origin: string | undefined, question = false
let quotaOptions: unknown
class ExecutionIdentityError extends Error {}
const unused = () => assert.fail('quota preparation cannot perform admission or grant a lease')
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../model-order.ts', {
  orderCandidates: async (_pool: unknown, actual: unknown) => { assert.deepEqual(actual, scope); calls.push('all'); return candidates },
  selectedOrderCandidates: async (_pool: unknown, actual: unknown, exact: unknown) => { assert.deepEqual(actual, scope); assert.deepEqual(exact, entry); calls.push('selected'); return candidates },
  credentialStates: async (_pool: unknown, actual: unknown, entries: unknown, authorized: unknown, _now: unknown, options: unknown) => {
    assert.deepEqual(actual, scope); assert.deepEqual(entries, [entry]); assert.equal(authorized, candidates)
    calls.push('quota'); quotaOptions = options; return new Map()
  },
})
stub('../computer/native-run-binding.ts', { nativeRunBinding: async (_pool: unknown, user: string, agent: string, harness: string, workspace: string, binding: string) => {
  assert.deepEqual([user, agent, harness, workspace, binding], [actor.userId, agentId, 'codex', actor.workspaceId, bindingId])
  calls.push('native-binding'); return bindingAvailable ? { connectionId, modelId: entry.model } : null
} })
stub('../execution-identity.ts', { ExecutionIdentityError, executionIdentityForRun: async (_pool: unknown, id: string, owner: string) => {
  assert.deepEqual([id, owner], [runId, actor.userId]); calls.push('identity')
  if (!identityAvailable) throw new ExecutionIdentityError('fixture denied')
} })
stub('./agent-profile.ts', { BUILTIN_AGENT_PROFILE_ID, assertProfileTarget: unused, assertProfileSelection: unused, isBuiltinAgentProfileSelection: unused })
stub('./profile-watchdog.ts', { watchdogProfileAdmission: unused, watchdogProfileClaimContext: unused })
const { refreshProfileQuota, refreshCloudRunProfileClaim } = await import('./profile-admission')
const pool = { query: async (sql: string, params: unknown[]) => {
  if (sql.includes('FROM agent_runs')) {
    assert.deepEqual(params, [runId, actor.userId, deviceId, actor.workspaceId])
    assert.ok(sql.includes("status='queued'") && sql.includes('"stopRequestedAt" IS NULL'))
    calls.push('queued-run')
    return { rows: [{ id: runId, questionContinuation: question, agentDefinition: { harness: 'codex', model: entry.model,
      agentProfile: selection, profileOriginRunId: origin, subscription: { bindingId } } }] }
  }
  assert.ok(sql.startsWith('SELECT 1 FROM byos_bindings'))
  assert.deepEqual(params, [bindingId, connectionId, entry.model, actor.workspaceId])
  calls.push('pinned-binding'); return { rowCount: Number(bindingAvailable) }
} } as unknown as Pool
const queue = () => refreshProfileQuota(pool, { ...scope, agentId, model: entry.model, subscriptionBindingId: bindingId, selection })
const claim = () => refreshCloudRunProfileClaim(pool, actor, runId, deviceId, bindingId)
beforeEach(() => { calls.length = 0; selection = structuredClone(selected); bindingAvailable = true; identityAvailable = true; origin = undefined; question = false; quotaOptions = undefined })

test('fixed queue quota reads only the admitted candidate after exact native binding validation', async () => {
  await queue()
  assert.deepEqual(calls, ['native-binding', 'selected', 'quota'])
  assert.equal(quotaOptions, undefined, 'queue retains the original stale-quota refresh policy')
})

test('fixed claim quota keeps its always probe after current run identity and exact binding validation', async () => {
  await claim()
  assert.deepEqual(calls, ['queued-run', 'identity', 'pinned-binding', 'selected', 'quota'])
  assert.deepEqual(quotaOptions, { probe: 'always' })
  await claim()
  assert.equal(calls.filter(call => call === 'quota').length, 2, 'a completed probe is not cached for another claim')
})

for (const mode of ['builtin', 'inherit'] as const) test(`${mode} quota preparation preserves the full preference path`, async () => {
  selection = mode === 'builtin' ? builtinAgentProfileSelection(scope, entry)
    : { ...selection, definition: { ...selection.definition, model: { mode: 'inherit' } } }
  await queue(); await claim()
  assert.equal(calls.filter(call => call === 'all').length, 2)
  assert.equal(calls.includes('selected'), false)
  assert.deepEqual(quotaOptions, { probe: 'always' })
})

test('revoked binding refuses both quota preparations before reading another source', async () => {
  bindingAvailable = false
  await queue(); await claim()
  assert.deepEqual(calls, ['native-binding', 'queued-run', 'identity', 'pinned-binding'])
})

test('revoked execution identity prevents the forced provider probe', async () => {
  identityAvailable = false
  await claim()
  assert.deepEqual(calls, ['queued-run', 'identity'])
})

for (const mode of ['origin', 'question'] as const) test(`${mode} continuation keeps its existing quota exemption`, async () => {
  if (mode === 'origin') origin = randomUUID()
  else question = true
  await claim()
  assert.deepEqual(calls, ['queued-run'])
})

test('foreign frozen scope cannot start quota preparation', async () => {
  selection.scope = { ...scope, ownerId: 'other-owner' }
  await queue(); await claim()
  assert.deepEqual(calls, ['queued-run'])
})
