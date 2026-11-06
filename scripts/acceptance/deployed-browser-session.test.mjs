import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { encode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'
import { DeployedTargetError } from './deployed-target.mjs'
import { runDeployedBrowserSmoke, verifyDeployedProductionReports, selectBrowserTeamWorkspace } from './deployed-browser-session.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const env = { MIKKA_ACCEPTANCE_TARGET_MODE: 'deployed-target' }
const teamProof = Object.freeze({
  teamWorkspaceConfirmed: true,
  teamWorkspaceHash: 'd'.repeat(64),
  teamSelectionBasis: 'unique-active-team-membership',
  teamOwnerAttribution: 'AGENTS.md-shared-account-team',
})
const proof = Object.freeze({
  targetMode: 'deployed-target', applicationSha: 'a'.repeat(40), driverRevision: 'b'.repeat(40),
  driverRunId: 101, driverRunAttempt: 1, webDeployRunId: 99, webAttempt: 2,
  deploymentId: 'dpl_syntheticfixture',
})
function fixture(options = {}) {
  const calls = [], saved = []
  let assertions = 0
  const response = (url, status = 200, value = null) => ({
    status: () => status, url: () => url,
    body: async () => Buffer.from('{}'), json: async () => value, dispose: async () => {},
  })
  const page = {
    on() {}, off() {},
    async close() { calls.push('close'); if (options.closeError) throw options.closeError },
    request: {
      async post(url, init) {
        calls.push('signout')
        assert.equal(url, ORIGIN + '/mikka/api/auth/sign-out')
        assert.deepEqual(init.data, {})
        assert.equal(init.headers.origin, ORIGIN)
        assert.equal(init.maxRedirects, 0)
        if (options.logoutError) throw options.logoutError
        return response(url, options.logoutStatus ?? 200)
      },
      async get(url, init) {
        calls.push('anonymous')
        assert.equal(url, ORIGIN + '/mikka/api/auth/get-session')
        assert.equal(init.maxRedirects, 0)
        return response(url, 200, options.sessionAfter ?? null)
      },
    },
  }
  const args = {
    page, baseURL: ORIGIN, env, event: {}, attestation: proof,
    assertTarget: async () => {
      assertions++
      calls.push('target' + assertions)
      if (assertions === 1 && options.beforeError) throw options.beforeError
      if (assertions === 2 && options.afterError) throw options.afterError
      return { ...proof }
    },
    saveReport: async report => saved.push(JSON.parse(JSON.stringify(report))),
    now: () => 1_700_000_000_000,
    smoke: async scope => {
      calls.push('smoke')
      scope.signInAttempted()
      if (!options.beforeIdentityError) {
        scope.identityConfirmed()
        if (!options.withoutTeam) scope.teamWorkspaceConfirmed?.(teamProof)
      }
      if (options.beforeIdentityError) throw options.beforeIdentityError
      if (options.uiError) throw options.uiError
    },
  }
  return { calls, saved, args }
}
test('real assertion path is bracketed by target proofs and current-cookie logout before the final proof', async () => {
  const f = fixture()
  const report = await runDeployedBrowserSmoke(f.args)
  assert.deepEqual(f.calls, ['target1', 'smoke', 'close', 'signout', 'anonymous', 'target2'])
  assert.equal(report.status, 'pass')
  assert.equal(report.sessionClosed, true)
  assert.equal(report.teamWorkspaceConfirmed, true)
  assert.equal(report.teamWorkspaceHash, teamProof.teamWorkspaceHash)
  assert.equal(report.cleanupSucceeded, true)
  assert.equal(report.driverRevision, proof.driverRevision)
  assert.notEqual(report.driverRevision, report.applicationSha)
})
test('a UI failure remains failed after successful logout without exposing its original value or cause', async () => {
  const secret = 'private assertion contents must remain in memory'
  const f = fixture({ uiError: new Error(secret, { cause: new Error(secret) }) })
  await assert.rejects(runDeployedBrowserSmoke(f.args), error => {
    assert.equal(error.message, 'browser_assertions_failed')
    assert.equal(error.cause, undefined)
    assert.equal(String(error.stack).includes(secret), false)
    return true
  })
  assert.equal(f.saved[0].status, 'fail')
  assert.equal(f.saved[0].cleanupSucceeded, true)
  assert.equal(JSON.stringify(f.saved).includes(secret), false)
})
test('target drift after the browser is inconclusive, still logs out, and never throws a raw target cause', async () => {
  const privateCause = new Error('private transport details')
  const f = fixture({ afterError: new DeployedTargetError('target_changed', { cause: privateCause }) })
  await assert.rejects(runDeployedBrowserSmoke(f.args), error => {
    assert.equal(error.message, 'browser_target_inconclusive')
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(f.saved[0].status, 'inconclusive')
  assert.equal(f.saved[0].code, 'target_changed')
  assert.equal(f.saved[0].sessionClosed, true)
  assert.equal(JSON.stringify(f.saved).includes(privateCause.message), false)
})
test('page close failure still attempts logout and remains failed even if the target also changed', async () => {
  for (const afterError of [undefined, new DeployedTargetError('target_changed')]) {
    const f = fixture({ closeError: new Error('closed failure details'), afterError })
    await assert.rejects(runDeployedBrowserSmoke(f.args), { message: 'browser_cleanup_failed' })
    assert.deepEqual(f.calls, ['target1', 'smoke', 'close', 'signout', 'anonymous', 'target2'])
    assert.equal(f.saved[0].pageClosed, false)
    assert.equal(f.saved[0].sessionClosed, true)
    assert.equal(f.saved[0].status, 'fail')
  }
})
test('a failed or uncertain sign-in still gets only normal current-cookie cleanup, with no clean business pass', async () => {
  const f = fixture({ beforeIdentityError: new Error('unavailable sign-in response') })
  await assert.rejects(runDeployedBrowserSmoke(f.args), { message: 'browser_assertions_failed' })
  assert.equal(f.saved[0].unknownSignInOutcome, true)
  assert.equal(f.saved[0].normalSessionObserved, false)
  assert.equal(f.saved[0].signOutAttempted, true)
  assert.equal(f.saved[0].status, 'fail')
})
test('logout failure does not prevent get-session and cannot hide the original UI failure', async () => {
  const f = fixture({ uiError: new Error('private UI'), logoutError: new Error('private logout') })
  await assert.rejects(runDeployedBrowserSmoke(f.args), { message: 'browser_assertions_failed' })
  assert.equal(f.calls.includes('anonymous'), true)
  assert.equal(f.saved[0].sessionClosed, false)
  assert.equal(f.saved[0].code, 'browser_assertions_failed')
  assert.equal(f.saved[0].cleanupCode, 'browser_signout_failed')
})
test('a refused target or foreign origin never reaches sign-in or another-origin credential request', async () => {
  const refused = fixture({ beforeError: new DeployedTargetError('target_attestation') })
  await assert.rejects(runDeployedBrowserSmoke(refused.args), { message: 'browser_target_blocked' })
  assert.deepEqual(refused.calls, ['target1', 'close'])
  const foreign = fixture()
  await assert.rejects(runDeployedBrowserSmoke({ ...foreign.args, baseURL: 'https://example.invalid' }),
    { message: 'browser_origin_rejected' })
  assert.deepEqual(foreign.calls, ['close'])
})
test('logout HTTP success alone is insufficient when the same request context still has a session', async () => {
  const f = fixture({ sessionAfter: { user: { id: 'private-owned-user' } } })
  await assert.rejects(runDeployedBrowserSmoke(f.args), { message: 'browser_cleanup_failed' })
  assert.equal(f.saved[0].anonymousAfterLogout, false)
  assert.equal(f.saved[0].sessionClosed, false)
  assert.equal(JSON.stringify(f.saved).includes('private-owned-user'), false)
})

function completedReports() {
  const truth = keys => Object.fromEntries(keys.map(key => [key, true]))
  return {
    browser: { ...proof, ...teamProof, status: 'pass', browserExecuted: true, assertionsPassed: true,
      normalSessionObserved: true, targetBeforeVerified: true, targetAfterVerified: true,
      pageClosed: true, signOutSucceeded: true, anonymousAfterLogout: true, sessionClosed: true,
      cleanupSucceeded: true, unknownSignInOutcome: false },
    managed: { ...proof, ...teamProof, status: 'pass', normalSessionObserved: true,
      submissionCount: 1, cleanupSubmissionCount: 0, sdkMutations: 0, cronRequests: 0,
      databaseWritesByDriver: 0, managed: { coordinatorCompleted: true, dueTimerObserved: true, timerTerminalRequired: false,
        concurrentReconciliationExcluded: false }, sessionClosed: true,
      futureScheduleConfirmedAbsent: true, futureScheduleEvidence: 'observed-once-definition-and-committed-operation' },
    mobileDaemon: { ...proof, ...teamProof, status: 'pass',
      checks: truth(['deployment','sessionOwner','mobileHomeOwner','publishedActions','enrollment',
        'registration','deviceOwner','schedulingDisabled','heartbeat','finalDeployment']),
      cleanup: truth(['credentialRevoked','oldCredentialRejected','deviceRemoved',
        'originalDevicesPreserved','originalCredentialsPreserved','sessionClosed']), errors: [] },
    mcp: { ...proof, ...teamProof, status: 'passed', toolsInvoked: 0, modelCalls: 0,
      teamBindingScope: 'owner-session', catalogueWorkspaceDataVerified: false,
      cleanup: { ...truth(['tokenRevoked','tokenRejected','clientDeleted','clientAbsent','normalSessionClosed','sessionAbsent']),
        failureCodes: [], unresolvedResources: false } },
  }
}
test('aggregate pass requires all four business results and their explicit cleanup plus a fresh final target proof', async () => {
  let checks = 0
  const report = await verifyDeployedProductionReports({ env, event: {}, attestation: proof,
    reports: completedReports(), assertTarget: async () => { checks++; return { ...proof } } })
  assert.equal(report.status, 'pass')
  assert.equal(report.allRequiredCleanupProven, true)
  assert.equal(report.teamWorkspaceHash, teamProof.teamWorkspaceHash)
  assert.equal(report.teamBindingScope, 'authenticated-sessions')
  assert.equal(report.mcpCatalogueWorkspaceDataVerified, false)
  assert.equal(checks, 1)
})
test('missing, non-pass, differently bound or incomplete-cleanup reports cannot pass by merely existing', async () => {
  const mutations = [
    r => { delete r.browser },
    r => { r.managed.status = 'inconclusive' },
    r => { r.mcp.driverRevision = 'c'.repeat(40) },
    r => { delete r.mobileDaemon.cleanup.credentialRevoked },
    r => { r.mcp.cleanup.unresolvedResources = true },
    r => { r.browser.sessionClosed = false },
  ]
  for (const mutate of mutations) {
    const reports = completedReports(); mutate(reports)
    let checks = 0
    await assert.rejects(verifyDeployedProductionReports({ env, event: {}, attestation: proof,
      reports, assertTarget: async () => { checks++; return { ...proof } } }), /production_report|production_cleanup/)
    assert.equal(checks, 0)
  }
})
test('all passing reports still cannot pass when the live target has changed before aggregation', async () => {
  await assert.rejects(verifyDeployedProductionReports({ env, event: {}, attestation: proof,
    reports: completedReports(), assertTarget: async () => { throw new DeployedTargetError('target_changed') } }),
  { code: 'target_changed' })
})

test('a normal session alone cannot pass without confirmed team selection and still logs out', async () => {
  const f = fixture({ withoutTeam: true })
  await assert.rejects(runDeployedBrowserSmoke(f.args), { code: 'browser_team_workspace_failed' })
  assert.equal(f.saved[0].teamWorkspaceConfirmed, false)
  assert.equal(f.saved[0].sessionClosed, true)
  assert.equal(f.saved[0].status, 'fail')
})
test('aggregate rejects personal-only or different team facts across independent session reports', async () => {
  const mutations = [
    r => { delete r.managed.teamWorkspaceConfirmed; r.managed.personalWorkspaceConfirmed = true },
    r => { r.browser.teamWorkspaceHash = 'e'.repeat(64) },
    r => { r.mobileDaemon.teamSelectionBasis = 'first-team' },
    r => { r.mcp.teamOwnerAttribution = 'guessed-by-name' },
    r => { r.mcp.catalogueWorkspaceDataVerified = true },
  ]
  for (const mutate of mutations) {
    const reports = completedReports(); mutate(reports)
    let finalReads = 0
    await assert.rejects(verifyDeployedProductionReports({ env, event: {}, attestation: proof,
      reports, assertTarget: async () => { finalReads++; return { ...proof } } }),
    { code: 'production_report_not_passed' })
    assert.equal(finalReads, 0)
  }
})

const ownerId = 'synthetic-shared-account'
const teamId = '10000000-0000-4000-8000-000000000001'
const personalId = '10000000-0000-4000-8000-000000000002'
function teamContext(options = {}) {
  const calls = [], drained = [], disposed = []
  const state = { selected: false }
  const origin = options.origin ?? ORIGIN
  const workspace = selected => ({
    currentUserId: ownerId,
    workspace: { id: selected ? teamId : personalId, kind: selected ? 'team' : 'personal' },
    role: 'member',
    choices: [{ id: personalId, kind: 'personal' }, { id: teamId, kind: 'team' }],
  })
  const response = (url, value, status = 200) => ({
    status: () => status,
    url: () => options.responseUrl ?? url,
    async body() { drained.push(url); return Buffer.from(JSON.stringify(value)) },
    async dispose() { disposed.push(url) },
  })
  const request = {
    async get(url, init) {
      calls.push({ method: 'GET', url, init })
      if (options.transportError) throw options.transportError
      if (url === origin + '/mikka/api/workspace') return response(url,
        workspace(state.selected && !options.ignoreCookie), options.status ?? 200)
      assert.equal(url, origin + '/mikka/api/auth/get-session')
      return response(url, { user: { id: ownerId } })
    },
    async post(url, init) {
      calls.push({ method: 'POST', url, init })
      assert.equal(url, origin + '/mikka/api/rpc')
      assert.equal(init.headers['x-mikka-rpc'], '1')
      assert.deepEqual(init.data, { version: DESKTOP_RPC_VERSION,
        action: 'workspace.switchWorkspace', args: [teamId] })
      // The fixture represents the same request context receiving Set-Cookie.
      // Neither the helper nor adapter sets a cookie/header on its own.
      state.selected = true
      return response(url, { version: DESKTOP_RPC_VERSION, ok: true,
        result: encode({ ok: true, data: { workspaceId: teamId } }) })
    },
  }
  return { page: { request }, calls, drained, disposed, origin }
}
test('browser adapter uses one normal context for switch and no-query team/session readback, including members', async () => {
  for (const origin of [ORIGIN, 'https://synthetic-preview.example.invalid']) {
    const f = teamContext({ origin })
    const result = await selectBrowserTeamWorkspace({ page: f.page, baseURL: origin, ownerId })
    assert.deepEqual(result, {
      teamWorkspaceConfirmed: true,
      teamWorkspaceHash: createHash('sha256').update('team-workspace\0' + teamId).digest('hex'),
      teamSelectionBasis: 'unique-active-team-membership',
      teamOwnerAttribution: 'AGENTS.md-shared-account-team',
    })
    assert.deepEqual(f.calls.map(call => [call.method, new URL(call.url).pathname]), [
      ['GET', '/mikka/api/workspace'], ['POST', '/mikka/api/rpc'],
      ['GET', '/mikka/api/workspace'], ['GET', '/mikka/api/auth/get-session'],
    ])
    for (const { method, url, init } of f.calls) {
      assert.equal(new URL(url).search, '')
      assert.equal(init.maxRedirects, 0)
      assert.equal(init.failOnStatusCode, false)
      assert.equal(init.timeout, 30_000)
      assert.deepEqual(init.headers, { origin, 'cache-control': 'no-store',
        ...(method === 'POST' ? { 'x-mikka-rpc': '1' } : {}) })
    }
    assert.equal(f.drained.length, 4)
    assert.equal(f.disposed.length, 4)
    assert.equal(JSON.stringify(result).includes(ownerId), false)
    assert.equal(JSON.stringify(result).includes(teamId), false)
  }
})
test('browser adapter rejects failed or redirected HTTP while draining and disposing the response', async () => {
  for (const options of [{ status: 403 }, { responseUrl: ORIGIN + '/mikka/api/workspace?workspace=' + teamId }]) {
    const f = teamContext(options)
    await assert.rejects(selectBrowserTeamWorkspace({ page: f.page, baseURL: ORIGIN, ownerId }),
      { code: 'team_workspace_failed', detail: 'workspace_read' })
    assert.equal(f.calls.length, 1)
    assert.equal(f.drained.length, 1)
    assert.equal(f.disposed.length, 1)
  }
})
test('browser readback must observe the normal switch cookie; a successful RPC alone does not select the team', async () => {
  const f = teamContext({ ignoreCookie: true })
  await assert.rejects(selectBrowserTeamWorkspace({ page: f.page, baseURL: ORIGIN, ownerId }),
    { code: 'team_workspace_failed', detail: 'workspace_changed' })
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(f.calls.length, 3)
  assert.equal(f.disposed.length, 3)
})
test('a team transport failure is closed before the default reporter and still triggers deployed logout', async () => {
  const privateValue = 'private-response-owner-and-session-details'
  const f = teamContext({ transportError: new Error(privateValue, { cause: new Error(privateValue) }) })
  let closedError
  try { await selectBrowserTeamWorkspace({ page: f.page, baseURL: ORIGIN, ownerId }) }
  catch (error) { closedError = error }
  assert.equal(closedError?.code, 'team_workspace_failed')
  assert.equal(closedError?.detail, 'workspace_read')
  assert.equal(closedError?.cause, undefined)
  assert.equal(String(closedError?.stack).includes(privateValue), false)
  const browser = fixture({ withoutTeam: true })
  browser.args.smoke = async scope => {
    scope.signInAttempted()
    scope.identityConfirmed()
    throw closedError
  }
  await assert.rejects(runDeployedBrowserSmoke(browser.args), { code: 'browser_team_workspace_failed' })
  assert.equal(browser.saved[0].sessionClosed, true)
  assert.deepEqual(browser.saved[0].teamWorkspaceFailure, { code: 'team_workspace_failed', detail: 'workspace_read' })
  assert.equal(JSON.stringify(browser.saved).includes(privateValue), false)
})
