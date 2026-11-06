import assert from 'node:assert/strict'
import test from 'node:test'
import { DeployedTargetError } from './deployed-target.mjs'
import { runDeployedBrowserSmoke, verifyDeployedProductionReports } from './deployed-browser-session.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const env = { MIKKA_ACCEPTANCE_TARGET_MODE: 'deployed-target' }
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
      if (!options.beforeIdentityError) scope.identityConfirmed()
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
    browser: { ...proof, status: 'pass', browserExecuted: true, assertionsPassed: true,
      normalSessionObserved: true, targetBeforeVerified: true, targetAfterVerified: true,
      pageClosed: true, signOutSucceeded: true, anonymousAfterLogout: true, sessionClosed: true,
      cleanupSucceeded: true, unknownSignInOutcome: false },
    managed: { ...proof, status: 'pass', normalSessionObserved: true, personalWorkspaceConfirmed: true,
      submissionCount: 1, cleanupSubmissionCount: 0, sdkMutations: 0, cronRequests: 0,
      databaseWritesByDriver: 0, managed: { coordinatorCompleted: true, dueTimerObserved: true, timerTerminalRequired: false,
        concurrentReconciliationExcluded: false }, sessionClosed: true,
      futureScheduleConfirmedAbsent: true, futureScheduleEvidence: 'observed-once-definition-and-committed-operation' },
    mobileDaemon: { ...proof, status: 'pass',
      checks: truth(['deployment','sessionOwner','mobileHomeOwner','publishedActions','enrollment',
        'registration','deviceOwner','schedulingDisabled','heartbeat','finalDeployment']),
      cleanup: truth(['credentialRevoked','oldCredentialRejected','deviceRemoved',
        'originalDevicesPreserved','originalCredentialsPreserved','sessionClosed']), errors: [] },
    mcp: { ...proof, status: 'passed', toolsInvoked: 0, modelCalls: 0,
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
