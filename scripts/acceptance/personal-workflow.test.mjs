import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import pins from '../../packages/daemon/harness/pins.json' with { type: 'json' }
import { createSessionClient, parseOptions, personalAcceptanceAccount, runCloudStartup, runSubscriptionCase, selectAcceptanceTeam, subscriptionProof } from './cloud-startup.mjs'
import { createWorkspaceProbe, runCodingWorkspaceAcceptance } from './coding-workspace.mjs'
import { PERSONAL_MODELS, personalReadiness, selectAcceptancePersonal } from './personal-workspace.mjs'
import { parsePersonalOptions, runPersonalWorkflow } from './personal-workflow.mjs'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ownerId = 'personal-acceptance-fixture', workspace = id(1), team = id(2), deviceId = id(3), agentId = id(4)
const build = 'a'.repeat(40), env = { SMOKE_OWNER_EMAIL: 'personal+mikka-smoke@example.invalid', SMOKE_OWNER_PASSWORD: 'fixture-only' }
const options = extra => parsePersonalOptions(['--origin', 'http://127.0.0.1:3000', '--workspace', workspace, ...extra], {})

function fixture(change = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const path = url.pathname.replace('/mikka', '')
    calls.push({ path, action: init.body && JSON.parse(init.body).action, method: init.method ?? 'GET' })
    const json = value => Response.json(value)
    if (path === '/api/version') return json({ build })
    if (path === '/api/auth/sign-in/email') return Response.json({}, { headers: { 'set-cookie': 'session=fixture-only; Path=/' } })
    assert.match(init.headers.cookie ?? '', /session=fixture-only/)
    if (path === '/api/auth/get-session') return json({ user: { id: change.sessionChanged ? 'other' : ownerId, email: env.SMOKE_OWNER_EMAIL } })
    if (path === '/api/auth/sign-out') return json({})
    if (path === '/api/workspace') {
      const selected = url.searchParams.get('workspace') ?? (/mikka-workspace=([^;]+)/.exec(init.headers.cookie)?.[1] ?? (change.noTeam ? workspace : team))
      return json({ currentUserId: ownerId, workspace: { id: selected, kind: selected === workspace && !change.wrongKind ? 'personal' : 'team' }, role: 'admin',
        choices: [{ id: workspace, kind: change.wrongKind ? 'team' : 'personal' }, ...(change.noTeam ? [] : [{ id: team, kind: 'team' }])],
        members: [{ userId: change.wrongOwner ? 'other' : ownerId, role: 'admin', status: 'active' }] })
    }
    if (path === '/api/subscriptions') return json({ enabled: change.runtime !== false, connections: change.missingSubscription ? []
      : Object.keys(PERSONAL_MODELS).map((harness, index) => ({ id: id(10 + index), provider: harness === 'codex' ? 'codex' : 'claude',
        state: change.subscriptionState ?? 'connected', paused: change.paused === true, account: 'PRIVATE_ACCOUNT_METADATA' })) })
    assert.equal(path, '/api/rpc', 'unexpected request before model execution')
    const { action, args } = JSON.parse(init.body)
    const rpc = result => json({ version: 1, ok: true, result })
    if (action === 'workspace.switchWorkspace') return Response.json({ version: 1, ok: true, result: { workspaceId: args[0] } }, {
      headers: change.dropCookie ? {} : { 'set-cookie': `mikka-workspace=${args[0]}; Path=/` },
    })
    if (action === 'agents.listDevices') return rpc(change.noDevice ? [] : [{ id: deviceId, online: !change.offline, enabled: !change.disabled,
      name: 'PRIVATE_DEVICE_METADATA', harnesses: Object.keys(PERSONAL_MODELS).map(harness => ({ harness, installed: true,
        version: change.oldCli ? '0.0.1' : pins.harnesses[harness].version, subscriptionBroker: !change.noBroker,
        ...(change.preflight ? { subscriptionPreflight: 'cli_missing' } : {}) })) }])
    if (action === 'agents.listAgents') return rpc([{ id: agentId, deviceId, harness: change.agentHarness ?? 'codex', instructions: 'PRIVATE_AGENT_METADATA' }])
    assert.equal(action, 'model-order.getModelOrder', 'unexpected mutation before readiness')
    return rpc({ candidates: Object.entries(PERSONAL_MODELS).map(([harness, model], index) => ({ harness,
      model: change.wrongModel ? 'another-model' : model, credentialOwnerId: change.foreignSource ? 'other' : ownerId,
      source: { kind: 'subscription', connectionId: id(10 + index) } })) })
  }
  return { fetchImpl, calls, async client() {
    const client = createSessionClient('http://127.0.0.1:3000', fetchImpl)
    await client.request('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify(env) })
    return client
  } }
}

test('personal entry is explicit, defaults to metadata, and never accepts a cloud or alternate-model execution', () => {
  assert.equal(options([]).operation, 'readiness')
  assert.equal(parseOptions([], {}).workspaceKind, undefined)
  for (const args of [[], ['--workspace-kind', 'team', '--workspace', workspace], ['--workspace', team, '--model', 'gpt-6-pro'],
    ['--workspace', workspace, '--operation', 'execute'], ['--workspace', workspace, '--operation', 'execute', '--harness', 'both']]) {
    assert.throws(() => parsePersonalOptions(args, {}))
  }
  const execute = options(['--operation', 'execute', '--harness', 'codex', '--device-id', deviceId, '--agent-id', agentId,
    '--expected-build', build, '--revision', build])
  assert.equal(execute.runs, 1)
  assert.equal(execute.harness, 'codex')
})

test('the old team-only selector rejects a personal-only account; the explicit personal selector selects its own exact cookie scope', async () => {
  const old = fixture({ noTeam: true })
  await assert.rejects(selectAcceptanceTeam(await old.client(), { ownerId }, () => {}), /team_workspace_failed/)
  const next = fixture({ noTeam: true })
  const scope = await selectAcceptancePersonal(await next.client(), { ownerId, workspace })
  assert.equal(scope.workspaceKind, 'personal')
  assert.equal(scope.adminId, ownerId)
  assert.equal(scope.evidence.personalWorkspaceConfirmed, true)
  for (const change of [{ wrongKind: true }, { wrongOwner: true }, { dropCookie: true }, { sessionChanged: true }]) {
    const bad = fixture(change)
    await assert.rejects(selectAcceptancePersonal(await bad.client(), { ownerId, workspace }), /startup_personal_/)
  }
})

test('ordinary local pool credentials require an attested loopback environment and never relax production smoke identity', async () => {
  const credentials = { SMOKE_OWNER_EMAIL: 'test-' + id(99) + '@example.test', SMOKE_OWNER_PASSWORD: 'x'.repeat(40) }
  await assert.rejects(personalAcceptanceAccount({ origin: 'https://app.aspectlylabs.com' }, { ...credentials, MIKKA_LOCAL_TEST_ACCOUNTS: '1' }), /startup_personal_account_unavailable/)
  await assert.rejects(personalAcceptanceAccount({ origin: 'http://127.0.0.1:3003' }, credentials), /startup_personal_account_unavailable/)
})

test('metadata readiness restores the original Workspace and never creates work or exposes account metadata', async () => {
  const io = fixture()
  const report = await runCloudStartup(options(['--harness', 'codex', '--device-id', deviceId, '--agent-id', agentId]), { ...io, env })
  assert.equal(report.status, 'ready_for_attempt')
  assert.equal(report.target, 'personal_readiness')
  assert.equal(report.executionVerified, false)
  assert.equal(report.cleanup.workspaceRestored, true)
  assert.deepEqual(report.samples, [])
  assert.deepEqual([...new Set(io.calls.filter(call => call.method === 'POST').map(call => call.action ?? call.path))].sort(),
    ['/api/auth/sign-in/email', '/api/auth/sign-out', 'agents.listAgents', 'agents.listDevices', 'model-order.getModelOrder', 'workspace.switchWorkspace'].sort())
  for (const value of ['fixture-only', env.SMOKE_OWNER_EMAIL, 'PRIVATE_ACCOUNT_METADATA', 'PRIVATE_DEVICE_METADATA', 'PRIVATE_AGENT_METADATA']) {
    assert.equal(JSON.stringify(report).includes(value), false)
  }
})

test('missing runtime, own subscription, exact model, device and native capability have closed independent readiness errors', async () => {
  for (const [change, code] of [[{ runtime: false }, 'runtime_unavailable'], [{ missingSubscription: true }, 'subscription_missing'],
    [{ subscriptionState: 'publication_pending' }, 'subscription_not_ready'], [{ paused: true }, 'subscription_not_ready'],
    [{ foreignSource: true }, 'model_missing_or_ambiguous'], [{ wrongModel: true }, 'model_missing_or_ambiguous'],
    [{ noDevice: true }, 'device_unavailable'], [{ offline: true }, 'device_unavailable'], [{ disabled: true }, 'device_unavailable'],
    [{ noBroker: true }, 'native_runtime_unavailable'], [{ preflight: true }, 'native_runtime_unavailable'],
    [{ oldCli: true }, 'native_runtime_unavailable'], [{ agentHarness: 'claude_code' }, 'agent_unavailable']]) {
    const io = fixture(change), client = await io.client()
    const scope = await selectAcceptancePersonal(client, { ownerId, workspace })
    const report = await personalReadiness(client, scope, { harness: 'codex', deviceId, agentId })
    assert.equal(report.status, 'blocked')
    assert.equal(report.executionVerified, false)
    assert.ok(report.checks[0].codes.includes('startup_personal_' + code), code)
  }
})

test('a blocked personal execute stops before Bot/profile/run creation and keeps the native model fixed', async () => {
  const io = fixture({ missingSubscription: true })
  const report = await runCloudStartup(options(['--operation', 'execute', '--harness', 'codex', '--device-id', deviceId,
    '--agent-id', agentId, '--expected-build', build, '--revision', build]), { ...io, env })
  assert.equal(report.status, 'failed')
  assert.equal(report.error, 'startup_personal_readiness_blocked')
  assert.equal(report.readiness.checks[0].model, 'gpt-6-luna')
  assert.deepEqual(report.samples, [])
  assert.equal(io.calls.some(call => call.action === 'bots.createBot' || call.path.includes('agent-profiles')), false)
})

test('personal subscription evidence requires requester ownership and owner access, preserving the shared proof fence', async () => {
  const botId = id(20), profileId = id(21), bindingId = id(22), runId = id(23), issueId = id(24)
  const io = fixture(), scope = { ...(await selectAcceptancePersonal(await io.client(), { ownerId, workspace })), botId }
  const profile = { id: profileId, version: 1, digest: 'b'.repeat(64), model: { source: { connectionId: id(11) } } }
  const identity = { version: 1, requester: ownerId, executionPrincipal: ownerId, botId, botOwner: ownerId, outputOwner: ownerId,
    workspaceId: workspace, personalResourcePolicy: 'requester_only', resourceBindings: [
      { kind: 'device', id: deviceId, ownerId, access: 'owner' }, { kind: 'subscription', id: bindingId, ownerId, access: 'owner', revision: '1' }],
    billingAccount: { model: { kind: 'subscription', ownerId, resourceId: bindingId }, runtime: { kind: 'local_device', ownerId, resourceId: deviceId } } }
  const run = { id: runId, issueId, harness: 'codex', model: 'gpt-6-luna', credentialType: 'subscription', subscriptionRoute: 'codex_cli',
    agentProfile: { profileId, version: 1, digest: profile.digest, source: 'explicit' }, executionIdentity: identity }
  const record = { runId, issueId, harness: 'codex', profileId, placement: { kind: 'device', deviceId } }
  await subscriptionProof({ json: async () => ({ run }) }, record, scope, profile)
  assert.equal(record.execution.personalScope.access, 'owner')
  assert.equal(record.execution.sharedScope, undefined)
  identity.resourceBindings[1].access = 'workspace_share'
  await assert.rejects(subscriptionProof({ json: async () => ({ run }) }, record, scope, profile), /startup_personal_subscription_identity_mismatch/)
})

test('personal cases select the own subscription menu for each fixed harness before creating any task', async () => {
  for (const [harness, modelId] of Object.entries(PERSONAL_MODELS)) {
    const botId = id(70), profileId = id(71), ownOption = id(72), sharedOption = id(73)
    const provider = harness === 'codex' ? 'codex' : 'claude', chosen = []
    const scope = { ownerId, adminId: ownerId, botId, workspaceId: workspace, workspaceKind: 'personal',
      acceptanceEmailHash: createHash('sha256').update(env.SMOKE_OWNER_EMAIL).digest('hex'), evidence: { personalWorkspaceConfirmed: true } }
    const client = { request() { throw Error('unexpected request') },
      json: async path => {
        if (path === '/api/auth/get-session') return { user: { id: ownerId, email: env.SMOKE_OWNER_EMAIL } }
        if (path === '/api/workspace') return { currentUserId: ownerId, workspace: { id: workspace, kind: 'personal' }, role: 'admin' }
        assert.equal(path, '/api/bots/' + botId); return { id: botId, name: '测试1505 personal' }
      }, rpc: async (action, args) => {
        if (action === 'execution-settings.getBotModelMenu') return { groups: [
          { kind: 'subscription', provider, options: [{ id: ownOption, provider, modelId }] },
          { kind: 'subscription', provider, owner: 'foreign member', options: [{ id: sharedOption, provider, modelId }] },
        ] }
        if (action === 'execution-settings.chooseBotModel') {
          chosen.push(args[1]); return { current: { kind: 'subscription', chosen: true, available: true, id: args[1], provider, modelId } }
        }
        assert.equal(action, 'issues.saveIssue')
        throw Error('startup_issue_create_failed')
      } }
    const record = await runSubscriptionCase({ client, scope, botId, profileId, profile: { id: profileId, digest: 'a'.repeat(64) },
      harness, deviceId, agentId, pinBuild: async () => {} })
    assert.deepEqual(chosen, [ownOption])
    assert.equal(record.error, 'startup_issue_create_failed')
    assert.equal(record.runId, undefined)
  }
})

test('personal Files issue creation uses the ordinary personal task action and never asks for a Team', async () => {
  const calls = [], scope = { ownerId, workspaceId: workspace, workspaceKind: 'personal', botId: id(30) }
  const probe = createWorkspaceProbe({ sourceCommit: build, workerSha: build, workerSourceCommit: build }, {
    client: { rpc: async (action, args) => { calls.push({ action, args }); return { issue: { id: id(31) } } } },
    record: { sampleId: 'personal_files', harness: 'codex' }, scope,
  })
  await probe.createIssue({ title: '测试 personal', status: 'todo' })
  assert.deepEqual(calls.map(call => call.action), ['issues.saveIssue'])
})

test('Files readiness delegates to the same startup driver and never claims execution from a green preflight', async () => {
  let seen
  const report = await runPersonalWorkflow({ ...options(['--probe', 'files']), expectedBuild: build,
    expectedWorkerSha: build, expectedWorkerSource: build }, { runStartup: async value => {
    seen = value
    return { status: 'ready_for_attempt', readiness: { status: 'ready_for_attempt', executionVerified: false }, cleanup: { errors: [], workspaceRestored: true } }
  } })
  assert.equal(seen.workspaceKind, 'personal')
  assert.equal(seen.workspace, workspace)
  assert.equal(report.status, 'ready_for_attempt')
  assert.equal(report.executionVerified, false)
  assert.deepEqual(report.samples, [])
  await assert.rejects(runCodingWorkspaceAcceptance({ sourceCommit: build, workerSha: build, workerSourceCommit: build,
    workspaceKind: 'personal', workspace, operation: 'execute', harness: 'both' }, { env, fetchImpl: () => { throw Error('must not sign in') } }))
})
