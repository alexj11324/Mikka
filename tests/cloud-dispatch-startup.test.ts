import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { ComputerError } from '../lib/computer/store'
import { ActionFailureError } from '../lib/action-error'
import * as profileDefinitions from '../lib/factory/agent-profile-definition'

const owner = 'synthetic-owner', botId = '10000000-0000-4000-8000-000000000001'
const issueId = '10000000-0000-4000-8000-000000000002', runId = '10000000-0000-4000-8000-000000000003'
const bindingId = '10000000-0000-4000-8000-000000000004', keyId = '10000000-0000-4000-8000-000000000005'
const priorRunId = '10000000-0000-4000-8000-000000000006'
const sourceEventId = '10000000-0000-4000-8000-000000000007', profileId = '10000000-0000-4000-8000-000000000008'
const workspaceId = 'workspace', agentId = 'agent', model = 'synthetic-model'
const calls: string[] = []
let failure: 'wake' | 'machine' | 'lifecycle' | null = null
let queueFailure: Error | null = null
let settledStartup = true
let present = true, workspaceAllowed = true, issueAllowed = true, suggestionAllowed = true
let permission: string | undefined, awake = true, credentialAvailable = true, switchedCredential = false
let moveDevice = false, replaceAgent = false, revokeDuringWake = false, revokeWorkspaceDuringWake = false
let selectedSource: 'subscription' | 'api_key' = 'subscription'
let selectedHarness: 'codex' | 'claude_code' = 'codex'
let selectedModel = model
let deviceId = 'device', repoId = 'repo'
let previous: { id: string; status: string; stopRequestedAt: null; agentId: string; readOnly: boolean } | null = null
let pendingSpec = false
let collaborationAllowed = true
const queuedAuthorities: unknown[] = []
const collaborationAuthority = { actorId: 'synthetic-member', threadOwnerId: owner, collaborationAuthorizationId: '10000000-0000-4000-8000-000000000009' }
const selectedStages: (string | undefined)[] = []
const selectedProfiles: (string | undefined)[] = []
const selectedLocations: (string | undefined)[] = []
let preferLocal = false
const hostSourceQueries: string[] = []
type RequestSource = { userId: string; botId: string; issueId: string | null; kind: string; deliveredAt: Date | null; payload: Record<string, unknown> }
let requestSource: RequestSource | null = null
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
  if (sql.includes('FROM coordinator_events')) {
    if (sql.startsWith('SELECT payload')) {
      const ownSource = requestSource?.userId === values[1] && requestSource?.botId === values[2] && requestSource?.kind === 'user_message'
      return { rows: ownSource ? [{ payload: requestSource!.payload }] : [], rowCount: Number(ownSource) }
    }
    hostSourceQueries.push(sql)
    const projected = requestSource && sql.includes('"hasTaskDestination"')
      ? { userId: requestSource.userId, botId: requestSource.botId, issueId: requestSource.issueId, kind: requestSource.kind,
        deliveredAt: requestSource.deliveredAt, hasTaskDestination: Object.hasOwn(requestSource.payload, 'taskDestination'), taskDestination: requestSource.payload.taskDestination ?? null }
      : requestSource
    return { rows: projected ? [projected] : [], rowCount: Number(Boolean(projected)) }
  }
  if (sql.includes('EXISTS (SELECT 1 FROM computer_run_bindings')) return { rows: [{ cloud: true }], rowCount: 1 }
  if (sql.includes('FROM agent_runs')) return { rows: previous ? [{ ...previous, remoteUrl: null, harness: 'codex', cloudWorkspaceId: workspaceId, cloudBotId: botId }] : [], rowCount: Number(Boolean(previous)) }
  if (sql.includes('FROM factory_tasks')) return { rows: pendingSpec ? [{ stage: 'spec', status: 'pending' }] : [], rowCount: Number(pendingSpec) }
  if (sql.includes('FROM bots') || sql.includes('FROM bot_cloud_runtimes')) return { rows: present && values[0] === botId && values[1] === owner ? [target()] : [], rowCount: Number(present) }
  throw new Error(`Unexpected query in startup fixture: ${sql}`)
}
const pool = { query, connect: async () => ({ query, release() {} }) }
stub('../lib/auth.ts', { auth: { api: {} } })
stub('../lib/cloud-computer-flag.ts', { cloudComputerRunsEnabled: () => true, cloudComputerTasksEnabled: () => true, byosEnabled: () => true, byosEnrollmentEnabled: () => true })
stub('../lib/db/index.ts', { db: { execute: async () => { calls.push('link-continuation'); return { rows: [], rowCount: 1 } } }, pool, withDatabaseClient: unused, withDatabaseTransaction: unused })
stub('../lib/agent-runs.ts', { queueRun: unused, queueFactoryRun: unused, addRunMessage: unused, readRun: unused, requestRunStop: unused, visibleRuns: unused })
stub('../lib/factory/queue-local.ts', { queueTaskRun: async () => {
  calls.push('local-queue-refused')
  throw new ActionFailureError('runInvalid', { reason: 'taskDestinationMismatch' })
} })
stub('../lib/issue-access.ts', { issueForUser: async () => issueAllowed ? { id: issueId, title: 'Task', content: { type: 'doc' } } : null, requireUser: async () => {} })
stub('../lib/coordinator/repository-resolution.ts', {
  withResolvedRepository: async (_owner: string, _issue: string, repo: string, dispatch: (repo: string) => Promise<unknown>) => dispatch(repo),
  sameRepository: unused, findRepository: unused,
})
stub('../lib/device-repositories.ts', {
  ensureDeviceRepository: async (user: string, device: string, repo: string) => {
    assert.equal(user, owner); assert.equal(device, deviceId); assert.equal(repo, 'owner/repository')
    calls.push('repository'); return { id: repoId }
  },
  readRepositoryDaemonSettings: unused, readRepositorySettings: unused, saveRepositoryVerifyCommand: unused,
})
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
stub('../lib/factory/agent-profile.ts', { ...profileDefinitions, assertProfileTarget: unused, assertProfileSelection: unused,
  resolveAgentProfileDispatch: async (db: unknown, scope: unknown, request: { stage?: string; profileId?: string; location?: string; asked?: { harness: string; model?: string } }) => {
    selectedStages.push(request.stage)
    selectedProfiles.push(request.profileId)
    selectedLocations.push(request.location)
    const { resolveModelDispatch } = await import('../lib/model-dispatch')
    const selected = await resolveModelDispatch(db as never, scope as never, request.asked as never)
    return { target: preferLocal && request.location !== 'cloud' ? { ...selected, kind: 'device', agentId, deviceId } : selected,
      selectionMode: request.asked?.model ? 'picked' : 'preference' }
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
stub('../lib/computer/cloud-task-target.ts', { cloudTaskTarget: unused, ownedCloudTaskTarget: unused, collaborativeCloudTaskTarget: async (_query: unknown, userId: string, input: Record<string, unknown>, authority: unknown) => {
  calls.push('collaboration-proof')
  assert.equal(userId, owner); assert.deepEqual(authority, collaborationAuthority)
  assert.deepEqual(input, { sourceRunId: priorRunId, botId, issueId, harness: 'codex', model, keyId })
  return collaborationAllowed ? { workspaceId, agentId: 'dedicated-agent', repoId: 'dedicated-repo', deviceId: 'dedicated-device', instructions: 'disclosed task instructions', harness: 'codex', baseBranch: 'main', remoteUrl: null } : null
} })
stub('../lib/computer/queue-run.ts', { queueCloudRun: unused })
stub('../lib/factory/queue-cloud.ts', { queueFactoryCloudRun: async (_pool: unknown, _actor: unknown, input: Record<string, unknown>, authority?: unknown) => {
  calls.push('queue')
  if ((!authority && !awake) || !credentialAvailable) throw new ComputerError(409, 'Bot subscription unavailable')
  assert.equal(input.agentId, authority ? 'dedicated-agent' : agentId)
  assert.equal(input.deviceRepoId, authority ? 'dedicated-repo' : repoId, 'queue uses its authorized runtime')
  if (authority) queuedAuthorities.push(structuredClone(authority))
  if (queueFailure) throw queueFailure
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
stub('../lib/run-leases.ts', { failUnclaimedCloudStart: async (actor: unknown, id: string, error: unknown) => {
  assert.deepEqual(actor, { userId: owner, workspaceId }); assert.equal(id, runId)
  assert.ok(error instanceof Error)
  calls.push('fail-unclaimed-start')
  return settledStartup
} })
mock.module('workflow/api', { namedExports: { start: async () => { calls.push('lifecycle'); if (failure === 'lifecycle') throw new Error('Synthetic workflow launch failure'); return { runId: 'workflow' } } } })
stub('../workflows/thread-machine/workflow.ts', { threadMachineLifecycle: async () => {} })
let dispatch: typeof import('../workflows/coordinator/steps')['dispatchComputerTask']
let dispatchThread: typeof import('../workflows/coordinator/steps')['dispatchComputerThread']
let dispatchRun: typeof import('../workflows/coordinator/steps')['dispatchRun']
before(async () => { ({ dispatchComputerTask: dispatch, dispatchComputerThread: dispatchThread, dispatchRun } = await import('../workflows/coordinator/steps')) })
beforeEach(() => {
  calls.length = 0; failure = null; queueFailure = null; settledStartup = true; present = workspaceAllowed = issueAllowed = suggestionAllowed = true
  permission = undefined; awake = credentialAvailable = true; switchedCredential = moveDevice = replaceAgent = revokeDuringWake = revokeWorkspaceDuringWake = false
  selectedSource = 'subscription'; selectedHarness = 'codex'; selectedModel = model; deviceId = 'device'; repoId = 'repo'
  previous = null; pendingSpec = false; requestSource = null; preferLocal = false; collaborationAllowed = true; queuedAuthorities.length = 0
  selectedStages.length = selectedProfiles.length = selectedLocations.length = hostSourceQueries.length = 0; modelResolutions = bindingSelections = credentialReads = 0; queued.clear()
})

const cloudTaskSource = (): RequestSource => ({ userId: owner, botId, issueId, kind: 'user_message', deliveredAt: new Date(),
  payload: { taskDestination: { kind: 'cloud' }, profileId } })
const dispatchRepository = (target?: 'cloud', eventId: string | undefined = sourceEventId) => dispatchRun(owner,
  { issueId, repo: 'owner/repository', requestKey: 'cloud-form-call', ...(target ? { target } : {}) }, undefined, botId, undefined, eventId)

for (const target of ['cloud', undefined] as const) test(`a bound task-form source keeps the selected cloud placement with ${target ?? 'omitted'} model target`, async () => {
  requestSource = cloudTaskSource()
  const result = await dispatchRepository(target)
  assert.ok('runId' in result, JSON.stringify(result))
  assert.deepEqual(calls, ['repository', 'queue', 'machine', 'lifecycle'])
  assert.deepEqual(selectedProfiles, [profileId], 'the task form retains the host-checked Profile')
  const input = queued.get('coordinator:rule:cloud-form-call')
  assert.equal(input?.sourceEventId, sourceEventId)
  assert.equal(input?.factoryBotId, botId)
  assert.equal((input?.modelDispatch as { location?: string })?.location, 'cloud')
  assert.equal(input?.allowLocalRecovery, undefined, 'a fixed cloud destination never grants local fallback')
  assert.equal(hostSourceQueries.length, 1, 'source admission retains one database read')
  assert.match(hostSourceQueries[0], /payload\s*\?\s*'taskDestination'/)
  assert.match(hostSourceQueries[0], /payload->'taskDestination'/)
  assert.doesNotMatch(hostSourceQueries[0], /\bpayload\s*(?:,|FROM)/, 'the source guard must not fetch the human prompt or complete payload')
})

for (const refusal of ['missing', 'owner', 'bot', 'issue', 'unbound', 'kind', 'undelivered', 'device', 'malformed', 'null'] as const) {
  test(`a ${refusal} task-form source cannot prepare or dispatch a cloud repository`, async () => {
    requestSource = cloudTaskSource()
    if (refusal === 'missing') requestSource = null
    else if (refusal === 'owner') requestSource.userId = 'other-owner'
    else if (refusal === 'bot') requestSource.botId = priorRunId
    else if (refusal === 'issue') requestSource.issueId = priorRunId
    else if (refusal === 'unbound') requestSource.issueId = null
    else if (refusal === 'kind') requestSource.kind = 'run_finished'
    else if (refusal === 'undelivered') requestSource.deliveredAt = null
    else if (refusal === 'device') requestSource.payload.taskDestination = { kind: 'device', deviceId: priorRunId }
    else if (refusal === 'malformed') requestSource.payload.taskDestination = { kind: 'cloud', deviceId: priorRunId }
    else requestSource.payload.taskDestination = null
    const result = await dispatchRepository('cloud')
    assert.equal('error' in result && result.error, 'runInvalid')
    assert.deepEqual(calls, [], 'source validation precedes runtime, repository and queue writes')
    assert.equal(bindingSelections, 0)
    assert.equal(queued.size, 0)
  })
}

test('ordinary existing-issue chat retains automatic placement and its selected Profile', async () => {
  requestSource = { ...cloudTaskSource(), issueId: null, payload: { profileId } }
  const result = await dispatchRepository()
  assert.ok('runId' in result, JSON.stringify(result))
  assert.deepEqual(selectedProfiles, [profileId])
  const input = queued.get('coordinator:rule:cloud-form-call')
  assert.equal((input?.modelDispatch as { location?: string })?.location, undefined)
  assert.equal(input?.allowLocalRecovery, true)
})

test('a cloud task-form choice overrides local preferences before selection when the model omits target', async () => {
  requestSource = cloudTaskSource(); preferLocal = true
  const result = await dispatchRepository()
  assert.ok('runId' in result, JSON.stringify(result))
  assert.deepEqual(selectedLocations, ['cloud'])
  assert.deepEqual(calls, ['repository', 'queue', 'machine', 'lifecycle'])
  assert.equal(queued.get('coordinator:rule:cloud-form-call')?.allowLocalRecovery, undefined)
})

test('cloud startup succeeds only after both machine preparation and lifecycle launch', async () => {
  const result = await dispatch(owner, { botId, issueId, harness: 'codex', model: 'synthetic-model' }, 'synthetic-call')
  assert.ok('runId' in result)
  assert.deepEqual(calls, ['queue', 'machine', 'lifecycle'])
})

for (const existing of [false, true]) test(`a ${existing ? 'pending' : 'requested'} specification selects the planner before normal desktop admission`, async () => {
  pendingSpec = existing
  const result = await dispatchThread(owner, { botId, issueId, harness: 'codex', ...(existing ? {} : { needsSpec: true }) }, 'spec-call')
  assert.ok('runId' in result)
  assert.deepEqual(selectedStages, ['spec'])
  assert.equal(queued.get('coordinator:spec-call')?.needsSpec, true)
  assert.deepEqual(calls, ['queue', 'machine', 'lifecycle'])
})

test('a desktop profile admission refusal reaches the tool with safe guidance and starts no run', async () => {
  const { AgentProfileAdmissionError } = await import('../lib/factory/profile-admission')
  queueFailure = Object.assign(new AgentProfileAdmissionError(), { message: 'synthetic-private-admission-detail' })
  selectedHarness = 'claude_code'
  const result = await dispatchThread(owner, { botId, issueId, harness: 'claude_code', model }, 'profile-admission-call')
  assert.deepEqual(result, {
    error: 'agentProfileUnavailable',
    detail: 'The profile or its authorized execution source changed before admission. Select an available profile again.',
  })
  assert.equal(queued.size, 0)
  assert.deepEqual(calls, ['queue'], 'a refused admission starts no machine or lifecycle and is not retried')
  assert.equal(modelResolutions, 1, 'refusal does not select another model')
  assert.equal(bindingSelections, 1, 'refusal does not bind another subscription')
  assert.ok(!JSON.stringify(result).includes('synthetic-private-admission-detail'))
})

test('direct desktop callers retain a profile refusal code and safe guidance without exception details', async () => {
  queueFailure = Object.assign(new profileDefinitions.AgentProfileError('agentProfileVersionConflict'), { message: 'synthetic-private-profile-detail' })
  const result = await dispatch(owner, { botId, issueId, harness: 'codex', model, subscriptionBindingId: bindingId }, 'profile-version-call')
  assert.deepEqual(result, {
    error: 'agentProfileVersionConflict',
    detail: 'No run was dispatched. The selected Factory profile is unavailable or no eligible profile fits this request.',
  })
  assert.equal(queued.size, 0)
  assert.deepEqual(calls, ['queue'])
  assert.equal(modelResolutions, 0)
  assert.equal(bindingSelections, 0)
  assert.ok(!JSON.stringify(result).includes('synthetic-private-profile-detail'))
})

test('model arguments cannot grant local recovery; only the separate host placement argument can', async () => {
  const input = { botId, issueId, harness: 'codex' as const, model, allowLocalRecovery: true }
  assert.ok('runId' in await dispatch(owner, input, 'untrusted-placement'))
  assert.equal(queued.get('coordinator:untrusted-placement')?.allowLocalRecovery, undefined)
  assert.ok('runId' in await dispatch(owner, input, 'automatic-placement', undefined, undefined, true))
  assert.equal(queued.get('coordinator:automatic-placement')?.allowLocalRecovery, true)
})

for (const stage of ['machine', 'lifecycle'] as const) test(`a ${stage} failure uses the unclaimed infrastructure-failure path without requesting a user stop`, async () => {
  failure = stage
  assert.deepEqual(await dispatch(owner, { botId, issueId, harness: 'codex', model: 'synthetic-model' }, 'synthetic-call'), { error: 'cloudComputerUnavailable', failedRunId: runId })
  assert.deepEqual(calls, ['queue', 'machine', ...(stage === 'lifecycle' ? ['lifecycle'] : []), 'fail-unclaimed-start'])
  assert.equal(modelResolutions, 0, 'a machine failure does not select another model')
  assert.equal(queued.get('coordinator:synthetic-call')?.model, model)
})

test('a lost startup-failure race grants no local placement recovery or failed-run ancestry', async () => {
  failure = 'machine'; settledStartup = false
  assert.deepEqual(await dispatch(owner, { botId, issueId, harness: 'codex', model }, 'lost-startup-race'), { error: 'cloudComputerUnavailable', recoveryBlocked: true })
  assert.deepEqual(calls, ['queue', 'machine', 'fail-unclaimed-start'])
  assert.equal(queued.size, 1); assert.equal(modelResolutions, 0)
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


test('a shared native turn carries its real actor and receipt without waking the owner Bot or borrowing a subscription', async () => {
  awake = false
  const result = await dispatch(owner, { botId, issueId, harness: 'codex', model, apiKeyId: keyId, threadRunId: priorRunId },
    'shared-call', undefined, undefined, undefined, collaborationAuthority)
  assert.ok('runId' in result, JSON.stringify(result))
  assert.deepEqual(calls, ['collaboration-proof', 'queue', 'machine', 'lifecycle'])
  assert.equal(bindingSelections, 0); assert.equal(credentialReads, 0); assert.equal(modelResolutions, 0)
  assert.equal(awake, false, 'the generic owner Bot remains asleep')
  assert.deepEqual(queuedAuthorities, [collaborationAuthority])
  const input = queued.get('coordinator:shared-call')!
  assert.equal(input.apiKeyId, keyId); assert.equal(input.threadRunId, priorRunId)
  assert.equal(input.subscriptionBindingId, undefined); assert.equal(input.allowLocalRecovery, undefined)
})

test('an expired shared receipt never queues, wakes or prepares a machine', async () => {
  collaborationAllowed = false
  const result = await dispatch(owner, { botId, issueId, harness: 'codex', model, apiKeyId: keyId, threadRunId: priorRunId },
    'expired-shared', undefined, undefined, undefined, collaborationAuthority)
  assert.deepEqual(result, { error: 'cloudComputerUnavailable' })
  assert.deepEqual(calls, ['collaboration-proof']); assert.equal(queued.size, 0)
})

for (const invalid of ['owner', 'subscription', 'local-recovery', 'missing-source'] as const) test(`a shared ${invalid} request fails before credential or machine side effects`, async () => {
  const input = { botId, issueId, harness: 'codex' as const, model, apiKeyId: keyId, threadRunId: priorRunId,
    ...(invalid === 'subscription' ? { subscriptionBindingId: bindingId } : {}) }
  if (invalid === 'missing-source') delete (input as { threadRunId?: string }).threadRunId
  const result = await dispatch(owner, input, 'invalid-shared', undefined, undefined, invalid === 'local-recovery' ? true : undefined,
    invalid === 'owner' ? { ...collaborationAuthority, actorId: owner } : collaborationAuthority)
  assert.deepEqual(result, { error: 'threadExecutionAuthorizationRequired' })
  assert.deepEqual(calls, []); assert.equal(queued.size, 0)
})

test('personal GitHub refusal remains distinct and starts no shared machine', async () => {
  queueFailure = new ComputerError(409, 'personal_git_authorization_required')
  const result = await dispatch(owner, { botId, issueId, harness: 'codex', model, apiKeyId: keyId, threadRunId: priorRunId },
    'private-git-shared', undefined, undefined, undefined, collaborationAuthority)
  assert.deepEqual(result, { error: 'personal_git_authorization_required' })
  assert.deepEqual(calls, ['collaboration-proof', 'queue'])
})
