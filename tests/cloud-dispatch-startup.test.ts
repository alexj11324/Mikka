import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { ComputerError } from '../lib/computer/store'

const owner = 'synthetic-owner', botId = '10000000-0000-4000-8000-000000000001'
const issueId = '10000000-0000-4000-8000-000000000002', runId = '10000000-0000-4000-8000-000000000003'
const bindingId = '10000000-0000-4000-8000-000000000004', keyId = '10000000-0000-4000-8000-000000000005'
const priorRunId = '10000000-0000-4000-8000-000000000006'
const workspaceId = 'workspace', agentId = 'agent', model = 'synthetic-model'
const calls: string[] = []
let failure: 'wake' | 'machine' | 'lifecycle' | null = null
let present = true, workspaceAllowed = true, issueAllowed = true, suggestionAllowed = true
let permission: string | undefined, awake = true, credentialAvailable = true, switchedCredential = false
let moveDevice = false, replaceAgent = false, revokeDuringWake = false, revokeWorkspaceDuringWake = false
let selectedSource: 'subscription' | 'api_key' = 'subscription'
let selectedHarness: 'codex' | 'claude_code' = 'codex'
let selectedModel = model
let deviceId = 'device', repoId = 'repo'
let previous: { id: string; status: string; stopRequestedAt: null; agentId: string; readOnly: boolean } | null = null
let modelResolutions = 0, bindingSelections = 0, credentialReads = 0
const queued = new Map<string, Record<string, unknown>>()
const subscription = { id: bindingId, consumerId: agentId, ownerId: owner, workspaceId, connectionId: 'connection', connectionRevision: 3, route: 'codex_cli', modelId: model }
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports: exports })
const unused = () => { throw new Error('Unexpected side effect in startup fixture') }
const target = () => ({ workspaceId, agentId: replaceAgent && awake ? 'different-agent' : agentId, repoId, deviceId })
async function query(sql: string, values: unknown[] = []) {
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 0 }
  if (sql.includes('FROM workspace_computer_policies')) return { rows: permission === undefined ? [] : [{ permission }], rowCount: 1 }
  if (sql.includes('FROM suggestion_executions')) return { rows: [], rowCount: Number(suggestionAllowed) }
  if (sql.startsWith('SELECT "agentDefinition"')) return { rows: [{ agentDefinition: { model, subscription: { bindingId } } }], rowCount: 1 }
  if (sql.includes('FROM agent_runs')) return { rows: previous ? [{ ...previous, remoteUrl: null, harness: 'codex', cloudWorkspaceId: workspaceId, cloudBotId: botId }] : [], rowCount: Number(Boolean(previous)) }
  if (sql.includes('FROM bots') || sql.includes('FROM bot_cloud_runtimes')) return { rows: present && values[0] === botId && values[1] === owner ? [target()] : [], rowCount: Number(present) }
  throw new Error(`Unexpected query in startup fixture: ${sql}`)
}
const pool = { query, connect: async () => ({ query, release() {} }) }
stub('../lib/auth.ts', { auth: { api: {} } })
stub('../lib/cloud-computer-flag.ts', { cloudComputerRunsEnabled: () => true, cloudComputerTasksEnabled: () => true, byosEnabled: () => true, byosEnrollmentEnabled: () => true })
stub('../lib/db/index.ts', { db: { execute: async () => { calls.push('link-continuation'); return { rows: [], rowCount: 1 } } }, pool, withDatabaseClient: unused, withDatabaseTransaction: unused })
stub('../lib/agent-runs.ts', { queueRun: unused, queueFactoryRun: unused, addRunMessage: unused, readRun: unused, requestRunStop: unused, visibleRuns: unused })
stub('../lib/issue-access.ts', { issueForUser: async () => issueAllowed ? { id: issueId, title: 'Task', content: { type: 'doc' } } : null, requireUser: async () => {} })
stub('../lib/subscription-runtime.ts', { authorizeSubscriptionWorkspace: async () => { if (!workspaceAllowed) throw new Error('Workspace access revoked') }, subscriptionRuntime: {} })
stub('../lib/run-chain.ts', { readRunChain: async () => ({ rootRunId: priorRunId }) })
stub('../lib/run-control.ts', { sendOwnedRunMessage: async () => { calls.push('message') } })
stub('../lib/model-dispatch.ts', {
  modelNotAllowed: async () => null,
  resolveModelDispatch: async () => {
    modelResolutions++
    return { kind: 'cloud', harness: selectedHarness, model: selectedModel, entry: { source: selectedSource === 'subscription' ? { kind: 'subscription', connectionId: subscription.connectionId } : { kind: 'api_key', keyId } } }
  },
  bindAgentToConnection: async (_pool: unknown, _scope: unknown, selectedAgent: string, _harness: string, connectionId: string, selected: string) => {
    bindingSelections++
    assert.equal(selectedAgent, agentId); assert.equal(connectionId, subscription.connectionId); assert.equal(selected, model)
    return bindingId
  },
})
stub('../lib/computer/native-run-binding.ts', { nativeRunBinding: async (_pool: unknown, user: string, agent: string, harness: string, workspace: string, binding?: string) => {
  credentialReads++
  assert.equal(user, owner); assert.equal(agent, agentId); assert.equal(harness, selectedHarness); assert.equal(workspace, workspaceId)
  if (binding) assert.equal(binding, bindingId)
  return credentialAvailable ? { ...subscription, route: selectedHarness === 'codex' ? 'codex_cli' : 'claude_code_cli' } : null
} })
stub('../lib/run-credential-source.ts', { runCredentialSource: async (_pool: unknown, input: { model: string; keyId?: string; subscription: typeof subscription | null }) => {
  assert.equal(input.model, model)
  if (!credentialAvailable) return { subscription: null }
  if (input.keyId || switchedCredential) return { subscription: null, apiKey: { keyId: switchedCredential ? 'another-key' : input.keyId, model } }
  return { subscription: input.subscription }
} })
stub('../lib/computer/auto-runtime.ts', { ensureBotCloudRuntime: async (_pool: unknown, actor: unknown, id: string, selection: unknown) => {
  assert.deepEqual(actor, { userId: owner, workspaceId }); assert.equal(id, botId)
  assert.deepEqual(selection, { harness: selectedHarness }, 'preparation must not choose or auto-bind another subscription')
  if (!awake) {
    calls.push('wake')
    if (failure === 'wake') return null
    awake = true
    if (moveDevice) { deviceId = 'replacement-device'; repoId = 'replacement-repo' }
    if (revokeDuringWake) credentialAvailable = false
    if (revokeWorkspaceDuringWake) workspaceAllowed = false
    selectedModel = 'changed-preference'
  }
  return { botId, harness: selectedHarness, agentId: replaceAgent ? 'different-agent' : agentId }
} })
stub('../lib/computer/queue-run.ts', { queueCloudRun: unused })
stub('../lib/factory/queue-cloud.ts', { queueFactoryCloudRun: async (_pool: unknown, _actor: unknown, input: Record<string, unknown>) => {
  calls.push('queue')
  if (!awake || !credentialAvailable) throw new ComputerError(409, 'Bot subscription unavailable')
  assert.equal(input.agentId, agentId)
  assert.equal(input.deviceRepoId, repoId, 'queue uses the prepared runtime, not the pre-wake repository')
  const key = input.idempotencyKey as string
  if (queued.has(key)) assert.deepEqual(input, queued.get(key), 'the same retry retains its exact request')
  else queued.set(key, structuredClone(input))
  return { runId }
} })
stub('../lib/cloud-computer/thread-machines.ts', {
  ensureThreadMachine: async () => { calls.push('machine'); if (failure === 'machine') throw new Error('Synthetic machine failure') },
  threadMachineAction: async (_pool: unknown, actor: unknown, id: string, action: string) => {
    assert.deepEqual(actor, { userId: owner, workspaceId: 'workspace' }); assert.equal(id, runId); assert.equal(action, 'end'); calls.push('end')
  },
})
mock.module('workflow/api', { namedExports: { start: async () => { calls.push('lifecycle'); if (failure === 'lifecycle') throw new Error('Synthetic workflow launch failure'); return { runId: 'workflow' } } } })
stub('../workflows/thread-machine/workflow.ts', { threadMachineLifecycle: async () => {} })
let dispatch: typeof import('../workflows/coordinator/steps')['dispatchComputerTask']
let dispatchThread: typeof import('../workflows/coordinator/steps')['dispatchComputerThread']
before(async () => { ({ dispatchComputerTask: dispatch, dispatchComputerThread: dispatchThread } = await import('../workflows/coordinator/steps')) })
beforeEach(() => {
  calls.length = 0; failure = null; present = workspaceAllowed = issueAllowed = suggestionAllowed = true
  permission = undefined; awake = credentialAvailable = true; switchedCredential = moveDevice = replaceAgent = revokeDuringWake = revokeWorkspaceDuringWake = false
  selectedSource = 'subscription'; selectedHarness = 'codex'; selectedModel = model; deviceId = 'device'; repoId = 'repo'
  previous = null; modelResolutions = bindingSelections = credentialReads = 0; queued.clear()
})

test('cloud startup succeeds only after both machine preparation and lifecycle launch', async () => {
  const result = await dispatch(owner, { botId, issueId, harness: 'codex', model: 'synthetic-model' }, 'synthetic-call')
  assert.ok('runId' in result)
  assert.deepEqual(calls, ['queue', 'machine', 'lifecycle'])
})

test('model arguments cannot grant local recovery; only the separate host placement argument can', async () => {
  const input = { botId, issueId, harness: 'codex' as const, model, allowLocalRecovery: true }
  assert.ok('runId' in await dispatch(owner, input, 'untrusted-placement'))
  assert.equal(queued.get('coordinator:untrusted-placement')?.allowLocalRecovery, undefined)
  assert.ok('runId' in await dispatch(owner, input, 'automatic-placement', undefined, undefined, true))
  assert.equal(queued.get('coordinator:automatic-placement')?.allowLocalRecovery, true)
})

for (const stage of ['machine', 'lifecycle'] as const) test(`a ${stage} failure ends the queued cloud run before returning an unavailable result`, async () => {
  failure = stage
  assert.deepEqual(await dispatch(owner, { botId, issueId, harness: 'codex', model: 'synthetic-model' }, 'synthetic-call'), { error: 'cloudComputerUnavailable' })
  assert.deepEqual(calls, ['queue', 'machine', ...(stage === 'lifecycle' ? ['lifecycle'] : []), 'end'])
})

for (const harness of ['codex', 'claude_code'] as const) for (const source of ['subscription', 'api_key'] as const) test(`a sleeping Bot dispatches ${harness} with its selected ${source}, without a separate wake tool`, async () => {
  awake = false; moveDevice = true; selectedSource = source; selectedHarness = harness
  const result = await dispatchThread(owner, { botId, issueId, harness }, 'sleeping-call')
  assert.ok('runId' in result)
  assert.deepEqual(calls, ['wake', 'queue', 'machine', 'lifecycle'])
  assert.equal(modelResolutions, 1, 'a wake does not reselect a model after preferences change')
  assert.equal(bindingSelections, source === 'subscription' ? 1 : 0)
  const [input] = queued.values()
  assert.equal(input.model, model)
  assert.equal(input.subscriptionBindingId, source === 'subscription' ? bindingId : undefined)
  assert.equal(input.apiKeyId, source === 'api_key' ? keyId : undefined)
})

for (const refusal of ['owner', 'runtime', 'workspace', 'issue', 'policy', 'suggestion', 'subscription', 'key-switch'] as const) test(`a ${refusal} refusal performs no cloud preparation or queue write`, async () => {
  awake = false
  if (refusal === 'runtime') present = false
  if (refusal === 'workspace') workspaceAllowed = false
  if (refusal === 'issue') issueAllowed = false
  if (refusal === 'policy') permission = 'deny'
  if (refusal === 'suggestion') suggestionAllowed = false
  if (refusal === 'subscription') credentialAvailable = false
  if (refusal === 'key-switch') switchedCredential = true
  const result = await dispatch(refusal === 'owner' ? 'another-owner' : owner, {
    botId, issueId, harness: 'codex', model,
    ...(refusal === 'key-switch' ? { apiKeyId: keyId } : { subscriptionBindingId: bindingId }),
    ...(refusal === 'suggestion' ? { suggestionId: issueId } : {}),
  }, 'refused-call')
  assert.ok('error' in result)
  assert.deepEqual(calls, [], 'authorization precedes provider I/O')
  assert.equal(queued.size, 0)
})

test('preparation permits authorized quota fallback and leaves the original selection for queue-time validation', async () => {
  awake = false; switchedCredential = true
  assert.ok('runId' in await dispatchThread(owner, { botId, issueId, harness: 'codex' }, 'subscription-call'))
  assert.deepEqual(calls, ['wake', 'queue', 'machine', 'lifecycle'])
  assert.equal(modelResolutions, 1)
  assert.equal(bindingSelections, 1)
  const [input] = queued.values()
  assert.equal(input.model, model)
  assert.equal(input.subscriptionBindingId, bindingId)
  assert.equal(input.apiKeyId, undefined, 'the runtime preparer does not freeze a substitute key')
})

for (const refusal of ['workspace', 'issue'] as const) test(`desktop dispatch rejects ${refusal} access before model resolution`, async () => {
  awake = false
  if (refusal === 'workspace') workspaceAllowed = false
  else issueAllowed = false
  const result = await dispatchThread(owner, { botId, issueId, harness: 'codex' }, 'refused-thread')
  assert.ok('error' in result)
  assert.equal(modelResolutions, 0)
  assert.deepEqual(calls, [])
})

test('a wake failure queues no run or continuation write for the ended thread', async () => {
  awake = false; failure = 'wake'
  previous = { id: priorRunId, status: 'succeeded', stopRequestedAt: null, agentId, readOnly: true }
  assert.deepEqual(await dispatchThread(owner, { botId, issueId, harness: 'codex', note: 'Continue the delivery.' }, 'continue-call'), { error: 'cloudComputerUnavailable' })
  assert.deepEqual(calls, ['wake'])
  assert.equal(queued.size, 0)
})

test('a wake cannot swap the selected Agent, even inside the same workspace', async () => {
  awake = false; replaceAgent = true
  assert.deepEqual(await dispatch(owner, { botId, issueId, harness: 'codex', model, subscriptionBindingId: bindingId }, 'changed-agent'), { error: 'cloudComputerUnavailable' })
  assert.deepEqual(calls, ['wake'])
  assert.equal(queued.size, 0)
})

test('a credential revoked during the wake is still rejected by the queue', async () => {
  awake = false; revokeDuringWake = true
  assert.deepEqual(await dispatch(owner, { botId, issueId, harness: 'codex', model, subscriptionBindingId: bindingId }, 'revoked-call'), { error: 'cloudComputerUnavailable' })
  assert.deepEqual(calls, ['wake', 'queue'])
  assert.equal(queued.size, 0)
})

test('workspace access revoked during the wake stops before queueing a run', async () => {
  awake = false; revokeWorkspaceDuringWake = true
  assert.deepEqual(await dispatch(owner, { botId, issueId, harness: 'codex', model, subscriptionBindingId: bindingId }, 'revoked-workspace'), { error: 'cloudComputerUnavailable' })
  assert.deepEqual(calls, ['wake'])
  assert.equal(queued.size, 0)
})

test('a repeated dispatch keeps its queue key and one run after waking once', async () => {
  awake = false
  const input = { botId, issueId, harness: 'codex' as const, model, subscriptionBindingId: bindingId }
  assert.ok('runId' in await dispatch(owner, input, 'same-call'))
  assert.ok('runId' in await dispatch(owner, input, 'same-call'))
  assert.equal(calls.filter(call => call === 'wake').length, 1)
  assert.equal(queued.size, 1)
  assert.equal([...queued.keys()][0], 'coordinator:same-call')
})

test('a completed thread retains its model, binding, ancestry and read-only policy through wake', async () => {
  awake = false
  previous = { id: priorRunId, status: 'succeeded', stopRequestedAt: null, agentId, readOnly: true }
  const result = await dispatchThread(owner, { botId, issueId, harness: 'codex', note: 'Continue the delivery.' }, 'continued-call')
  assert.equal('thread' in result && result.thread, 'continued')
  assert.equal('continuesRunId' in result && result.continuesRunId, priorRunId)
  assert.equal(modelResolutions, 0, 'a continuation uses its frozen source')
  const [input] = queued.values()
  assert.equal(input.threadRunId, priorRunId)
  assert.equal(input.model, model)
  assert.equal(input.subscriptionBindingId, bindingId)
  assert.equal(input.apiKeyId, undefined)
  assert.equal(input.readOnly, true)
  assert.equal(input.idempotencyKey, `coordinator:thread:${priorRunId}:continued-call`)
})

test('a working thread receives its message without waking or reselecting anything', async () => {
  awake = false
  previous = { id: priorRunId, status: 'running', stopRequestedAt: null, agentId, readOnly: false }
  const result = await dispatchThread(owner, { botId, issueId, harness: 'codex', note: 'Additional context.' }, 'working-call')
  assert.equal('thread' in result && result.thread, 'message')
  assert.deepEqual(calls, ['message'])
  assert.equal(credentialReads, 0)
  assert.equal(modelResolutions, 0)
  assert.equal(queued.size, 0)
})
