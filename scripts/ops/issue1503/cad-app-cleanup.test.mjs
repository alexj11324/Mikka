import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cleanupCadFixture, createConfiguredStore, FIXTURE, validateSnapshot } from './cad-app-cleanup.mjs'

const PROFILE = 'f3897bf8-0726-4b5c-9a94-49fd7be8480f'
const HASH = 'a'.repeat(64)
function fixture(ended = false) {
  const run = { userId: FIXTURE.ownerId, issueId: FIXTURE.issueId, botId: FIXTURE.botId, deviceId: FIXTURE.deviceId,
    agentId: FIXTURE.agentId, profileId: PROFILE, profileVersion: 1, profileDigest: HASH,
    profileOwnerId: FIXTURE.ownerId, profileWorkspaceId: FIXTURE.workspaceId, retryOf: null, stopRequestedAt: null, finishedAt: null }
  return {
    device: { id: FIXTURE.deviceId, ownerId: FIXTURE.ownerId, kind: 'local', enabled: true, removedAt: null },
    agent: { id: FIXTURE.agentId, userId: FIXTURE.ownerId, harness: 'codex', deviceId: FIXTURE.deviceId },
    bot: { id: FIXTURE.botId, ownerId: FIXTURE.ownerId, workspaceId: FIXTURE.workspaceId },
    issue: { id: FIXTURE.issueId, userId: FIXTURE.ownerId, scope: 'personal', scopeVersion: 1, revision: 3,
      bodySha256: HASH, titleSha256: HASH, testTitle: true, deletedAt: null, number: 51, teamLink: null },
    runs: [{ ...run, id: FIXTURE.rootRunId, status: 'failed', stopReason: 'error', continuesRunId: null },
      { ...run, id: FIXTURE.childRunId, status: ended ? 'stopped' : 'queued', stopReason: null, continuesRunId: FIXTURE.rootRunId }],
    profile: { id: PROFILE, ownerId: FIXTURE.ownerId, workspaceId: FIXTURE.workspaceId, historicalMatches: true,
      version: 1, digest: HASH, frozenVersion: 1, frozenDigest: HASH, archivedAt: null, fixtureTag: '1a2b3c4d' },
    dependencies: { factoryTasks: 0, machineBindings: 0, activeBotLeases: 0, pendingCoordinatorWork: 0, otherLiveProfileRuns: 0, foreignDeviceAgents: 0 },
  }
}
function fakeStore(initial, overrides = {}) {
  const state = structuredClone(initial), calls = []
  const store = {
    read: async () => structuredClone(state),
    stop: async () => { calls.push('stop'); state.runs[1].status = 'stopped'; return { stoppedRunIds: [FIXTURE.childRunId] } },
    removeDevice: async () => { calls.push('remove'); state.device.enabled = false; state.device.removedAt = '2026-11-07T05:00:00Z'; state.agent.deviceId = null; return { id: FIXTURE.deviceId, revokedTokens: 1, uninstall: 'not_possible' } },
    archiveProfile: async () => { calls.push('archive'); state.profile.archivedAt = '2026-11-07T05:00:00Z'; state.profile.version++; state.profile.digest = 'b'.repeat(64); return { id: PROFILE, version: 2 } },
    deleteIssue: async expected => { calls.push('delete'); assert.equal(expected.revision, state.issue.revision); state.issue.deletedAt = '2026-11-07T05:00:00Z'; state.issue.revision++; return { id: FIXTURE.issueId, revision: state.issue.revision } },
    credentials: async () => ({ unboundedLiveCredentials: 0, gracePeriodCredentials: 0, boundAgents: 0 }),
    timingVariables: async () => ({ matchingFixtureCount: 0, retained: [], mutated: false, valuesRead: false }),
    ...overrides,
  }
  return { store, calls, state }
}

test('normal queued-child cleanup retains failed acceptance and original run history', async () => {
  const { store, calls } = fakeStore(fixture())
  const result = await cleanupCadFixture(store)
  assert.equal(result.status, 'passed')
  assert.deepEqual(calls, ['stop', 'remove', 'archive', 'delete'])
  assert.equal(result.acceptancePassed, false)
  assert.equal(result.after.runs[0].status, 'failed')
  assert.equal(result.after.issue.number, 51)
})

test('already stopped child is observed and never attributed to this operator', async () => {
  const { store, calls } = fakeStore(fixture(true))
  const result = await cleanupCadFixture(store)
  assert.equal(result.status, 'passed')
  assert.equal(calls.includes('stop'), false)
  assert.deepEqual(result.actions[0], { name: 'stop_actual_chain', status: 'already_terminal_before_operator' })
})

test('already removed, archived and soft-deleted fixture performs no mutation', async () => {
  const input = fixture(true)
  input.device.enabled = false; input.device.removedAt = '2026-11-07T04:40:00Z'; input.agent.deviceId = null
  input.profile.archivedAt = '2026-11-07T04:40:00Z'; input.profile.version = 2; input.profile.digest = 'b'.repeat(64)
  input.issue.deletedAt = '2026-11-07T04:40:00Z'
  const { store, calls } = fakeStore(input)
  assert.equal((await cleanupCadFixture(store)).status, 'passed')
  assert.deepEqual(calls, [])
})

test('foreign owner, third run, wrong parent, mismatched profile and active dependency reject before writes', async () => {
  const mutations = [state => { state.device.ownerId = 'foreign' },
    state => { state.runs.push({ ...state.runs[1], id: '153feab4-02bb-46a8-aee4-c5a20a873791' }) },
    state => { state.runs[1].continuesRunId = state.runs[1].id },
    state => { state.runs[1].profileId = null }, state => { state.dependencies.activeBotLeases = 1 },
    state => { state.dependencies.foreignDeviceAgents = 1 }, state => { state.dependencies.pendingCoordinatorWork = 1 },
    state => { state.issue.scope = 'workspace'; state.issue.teamLink = { issueId: FIXTURE.issueId,
      userId: FIXTURE.ownerId, workspaceId: '7313fe0a-62c7-43f4-87bf-d7c0b0fc28c3' } }]
  for (const mutate of mutations) {
    const input = fixture(); mutate(input)
    assert.throws(() => validateSnapshot(input), /^Error: issue1503_cad_cleanup_/)
    const { store, calls } = fakeStore(input)
    assert.equal((await cleanupCadFixture(store)).status, 'failed')
    assert.deepEqual(calls, [])
  }
})

test('accepted stop without terminal child does not remove the device or delete the task', async () => {
  const { store, calls } = fakeStore(fixture(), { stop: async () => ({ stoppedRunIds: [FIXTURE.childRunId] }) })
  const result = await cleanupCadFixture(store)
  assert.equal(result.code, 'issue1503_cad_cleanup_chain_not_terminal')
  assert.deepEqual(calls, [])
  assert.equal(result.actualFailureState.allRunsTerminal, false)
})

test('unknown timing-variable residue is retained and cannot be reported as complete cleanup', async () => {
  const { store } = fakeStore(fixture(true), { timingVariables: async () => ({ matchingFixtureCount: 1,
    retained: [{ id: 'b914e295-0709-439c-9703-c6431123e6b5' }], valuesRead: false, mutated: false }) })
  const result = await cleanupCadFixture(store)
  assert.equal(result.status, 'failed')
  assert.equal(result.code, 'issue1503_cad_cleanup_timing_variable_retained')
  assert.equal(result.timingVariableReadback.mutated, false)
})

// These values only exercise the configuration gate. The loader is stubbed or
// rejected before any service import; no database/provider connection is made.
const runtimeEnvironment = {
  GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/ops/issue-1503-cad-app-cleanup',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '42341975974', GITHUB_RUN_ATTEMPT: '1',
  NODE_ENV: 'production', VERCEL_ENV: 'production',
  MIKKA_DATABASE_URL: 'postgresql://unused:unused@offline-test.neon.tech/unused',
  DATABASE_URL: 'postgresql://unused:unused@offline-test.neon.tech/unused',
  DEVICE_GATEWAY_URL: 'https://offline-test.invalid', DEVICE_GATEWAY_PUSH_SECRET: 'unused',
  BETTER_AUTH_URL: 'https://app.aspectlylabs.com',
}

test('missing auth configuration is rejected with a checkpoint before service loading', async () => {
  for (const auth of [{}, { BETTER_AUTH_SECRET: '  ' },
    { BETTER_AUTH_SECRET: 'offline-gate-value', BETTER_AUTH_URL: 'https://app.aspectlylabs.com/mikka' }]) {
    const report = { status: 'starting' }, checkpoints = []
    let loaded = false
    await assert.rejects(createConfiguredStore({ ...runtimeEnvironment, ...auth }, report,
      async () => checkpoints.push(structuredClone(report)), async () => { loaded = true }),
    /^Error: issue1503_cad_cleanup_auth_(configuration_missing|origin_invalid)$/)
    assert.equal(loaded, false)
    assert.deepEqual(checkpoints.map(value => value.stage), ['configuration'])
    assert.equal(checkpoints[0].identity.runId, runtimeEnvironment.GITHUB_RUN_ID)
    assert.equal(JSON.stringify(report).includes('offline-gate-value'), false)
  }
})

test('starting service-import checkpoint is persisted before the loader can fail', async () => {
  const report = { status: 'starting' }, checkpoints = [], failure = new Error('offline loader failure')
  await assert.rejects(createConfiguredStore({ ...runtimeEnvironment, BETTER_AUTH_SECRET: 'offline-gate-value' }, report,
    async () => checkpoints.push(structuredClone(report)), async () => {
      assert.deepEqual(checkpoints.map(value => value.stage), ['configuration', 'service_import'])
      assert.ok(checkpoints.every(value => value.status === 'starting'))
      throw failure
    }), error => error === failure)
  assert.equal(checkpoints.at(-1).identity.sourceCommit, runtimeEnvironment.GITHUB_SHA)
})

test('CLI missing-secret failure leaves a closed safe receipt without importing services', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mikka-cad-config-'))
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./cad-app-cleanup.mjs', import.meta.url))],
      { cwd, env: runtimeEnvironment, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 1)
    assert.equal(result.stderr, '')
    const report = JSON.parse(await readFile(join(cwd, 'issue1503-report/cad-app-cleanup.json'), 'utf8'))
    assert.equal(report.status, 'failed')
    assert.equal(report.code, 'issue1503_cad_cleanup_auth_configuration_missing')
    assert.equal(report.stage, 'configuration')
    assert.equal(report.identity.runId, runtimeEnvironment.GITHUB_RUN_ID)
    assert.equal(report.background.waitUntilPromisesAwaited, 0)
    assert.equal(report.before, undefined)
    assert.equal(report.actions, undefined)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
