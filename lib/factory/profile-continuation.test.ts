import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { AgentProfileSelection } from './agent-profile'

// Exercise the real Profile admission boundary. The receipt reader and live
// catalogue are transport/storage boundaries here; their SQL fences run in
// profile-dispatch.db.test.ts against real PostgreSQL.
const checking = Object.assign(new Error('agentProfileModelUnavailable'), { code: 'agentProfileModelUnavailable', detail: 'checking' })
let receipt: { questionOriginRunId: string } | null = { questionOriginRunId: 'origin' }
mock.module('./agent-profile.ts', { namedExports: {
  BUILTIN_AGENT_PROFILE_ID: 'default', isBuiltinAgentProfileSelection: () => false,
  assertProfileTarget: async () => { throw checking },
  assertProfileSelection: async () => { throw checking },
} })
mock.module('./questions/execution-continuation.ts', { namedExports: {
  questionExecutionContinuation: async () => null,
  questionPlanContinuation: async () => receipt,
} })
mock.module('./profile-watchdog.ts', { namedExports: {
  watchdogProfileAdmission: async () => 'none', watchdogProfileClaimContext: async () => null,
} })
mock.module('../model-order.ts', { namedExports: { credentialStates: async () => new Map(), orderCandidates: async () => [],
  selectedOrderCandidates: async () => { assert.fail('continuation admission must not reselect quota candidates') },
} })
mock.module('../model-routing.ts', { namedExports: { MODEL_ROUTING_TIERS: ['light'], modelTier: () => 'light' } })
mock.module('../execution-identity.ts', { namedExports: { executionIdentityForRun: async () => undefined, ExecutionIdentityError: class extends Error {} } })
const admission = import('./profile-admission')
const assertRunProfileClaim = async (...args: Parameters<typeof import('./profile-admission').assertRunProfileClaim>) =>
  (await admission).assertRunProfileClaim(...args)

function fixture() {
  receipt = { questionOriginRunId: 'origin' }
  const selection = { profileId: 'profile', version: 2, digest: 'frozen-digest', source: 'explicit',
    scope: { ownerId: 'owner', workspaceId: 'workspace' },
    targetEntry: { id: 'entry', harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: 'connection' } },
  } as AgentProfileSelection
  const definition = { harness: 'codex', model: 'gpt-6-luna', readOnly: true,
    agentProfile: selection, executionIdentity: { workspaceId: 'workspace' }, subscription: { bindingId: 'binding' } }
  const run = { id: 'child', userId: 'owner', issueId: 'issue', kind: 'plan', status: 'queued',
    stopRequestedAt: null, agentDefinition: structuredClone(definition),
    questionContinuation: { questionId: 'question', originRunId: 'origin', originSessionId: 'native-session', requireSessionResume: true } as unknown }
  const origin = { agentDefinition: structuredClone(definition), startedAt: new Date(), sessionId: 'native-session',
    status: 'stopped', stopReason: 'blocked', stopRequestedAt: null }
  let bindingAvailable = true
  const query = { async query(sql: string, values: unknown[] = []) {
    if (sql === 'SELECT * FROM agent_runs WHERE id=$1') return { rows: [run] }
    if (sql.includes('FROM factory_tasks t')) return { rows: [{ id: 'task', userId: 'owner', issueId: 'issue', stage: 'spec', attemptId: 'attempt' }] }
    if (sql.startsWith('SELECT 1 FROM byos_bindings')) return { rows: bindingAvailable ? [{}] : [], rowCount: bindingAvailable ? 1 : 0 }
    if (sql.startsWith('SELECT "agentDefinition","startedAt"')) {
      assert.equal(values[0], 'origin', 'only the receipt-bound original run grants the native role')
      return { rows: [origin] }
    }
    return { rows: [] }
  } }
  return { run, origin, query: query as Parameters<typeof assertRunProfileClaim>[0], revokeBinding: () => { bindingAvailable = false } }
}

test('a receipt-bound spec question keeps its frozen Profile when the live quota snapshot is checking', async () => {
  const f = fixture()
  await assertRunProfileClaim(f.query, f.run.id)
  assert.equal(f.run.agentDefinition.subscription.bindingId, 'binding')
  assert.equal(f.run.questionContinuation && (f.run.questionContinuation as { originSessionId: string }).originSessionId, 'native-session')
})

test('a fresh plan still rejects a checking quota snapshot', async () => {
  const f = fixture(); f.run.questionContinuation = null
  await assert.rejects(assertRunProfileClaim(f.query, f.run.id), error =>
    (error as { code?: string; detail?: string; cause?: unknown }).code === 'agentProfileUnavailable' &&
    (error as { detail?: string }).detail === 'current_profile' && (error as Error).cause === checking)
})

test('question JSON without a host receipt cannot authorize a frozen plan Profile', async () => {
  const f = fixture(); receipt = null
  await assert.rejects(assertRunProfileClaim(f.query, f.run.id), { code: 'agentProfileUnavailable', detail: 'question_receipt' })
})

test('a stopped plan child cannot claim the old native Profile', async () => {
  const f = fixture(); f.run.stopRequestedAt = new Date() as never
  await assert.rejects(assertRunProfileClaim(f.query, f.run.id), { code: 'agentProfileUnavailable', detail: 'question_receipt' })
})

test('a receipt never grants a different model, Profile snapshot or missing subscription binding', async () => {
  const changedModel = fixture(); changedModel.run.agentDefinition.model = 'another-model'
  await assert.rejects(assertRunProfileClaim(changedModel.query, changedModel.run.id), { detail: 'target_mismatch' })
  const changedProfile = fixture(); changedProfile.run.agentDefinition.agentProfile.digest = 'different-role'
  await assert.rejects(assertRunProfileClaim(changedProfile.query, changedProfile.run.id), { detail: 'continuation_mismatch' })
  const revoked = fixture(); revoked.revokeBinding()
  await assert.rejects(assertRunProfileClaim(revoked.query, revoked.run.id), { detail: 'binding_unavailable' })
})

test('a source that never established a native session cannot grant a plan continuation', async () => {
  const f = fixture(); f.origin.sessionId = null as never
  await assert.rejects(assertRunProfileClaim(f.query, f.run.id), { code: 'agentProfileUnavailable' })
})
