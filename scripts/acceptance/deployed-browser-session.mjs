import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { assertDeployedTarget, DeployedTargetError, publicTargetFailure } from './deployed-target.mjs'
import { selectTeamWorkspace, isTeamWorkspaceReadPath, isTeamWorkspaceSwitchRequest, TeamWorkspaceError,
  publicTeamWorkspaceFailure } from './team-workspace.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const SIGN_OUT = ORIGIN + '/mikka/api/auth/sign-out'
const SESSION = ORIGIN + '/mikka/api/auth/get-session'
const REPORT = 'production-deployed-browser-report/report.json'
const MODE = 'deployed-target'
const CODES = new Set([
  'browser_mode_rejected', 'browser_origin_rejected', 'browser_contract_rejected',
  'browser_assertions_failed', 'browser_session_not_observed', 'browser_cleanup_failed',
  'browser_page_close_failed', 'browser_signout_failed', 'browser_session_still_present',
  'browser_report_failed', 'browser_target_blocked', 'browser_target_inconclusive', 'browser_team_workspace_failed',
  'production_reports_invalid', 'production_report_missing', 'production_report_binding_mismatch',
  'production_report_not_passed', 'production_cleanup_unproven',
])
export class DeployedBrowserError extends Error {
  constructor(code) {
    super(CODES.has(code) ? code : 'browser_assertions_failed')
    this.name = 'DeployedBrowserError'
    this.code = this.message
  }
}
const check = (ok, code) => { if (!ok) throw new DeployedBrowserError(code) }
const BINDING_FIELDS = ['targetMode', 'applicationSha', 'driverRevision', 'driverRunId',
  'driverRunAttempt', 'webDeployRunId', 'webAttempt', 'deploymentId']
const projectBinding = proof => Object.fromEntries(BINDING_FIELDS.map(key => [key, proof[key]]))
const TEAM_FIELDS = ['teamWorkspaceConfirmed', 'teamWorkspaceHash', 'teamAdminMembershipVerified',
  'teamSelectionBasis', 'teamOwnerAttribution']
const isConfirmedTeam = value => value?.teamWorkspaceConfirmed === true &&
  value.teamAdminMembershipVerified === true &&
  typeof value.teamWorkspaceHash === 'string' && /^[a-f0-9]{64}$/.test(value.teamWorkspaceHash) &&
  value.teamSelectionBasis === 'unique-active-admin-identity-match' &&
  value.teamOwnerAttribution === 'AGENTS.md-and-owner-comment-1504-6691409495'
const projectTeam = proof => Object.fromEntries(TEAM_FIELDS.map(key => [key, proof[key]]))
const publicFailure = error => error instanceof DeployedTargetError
  ? publicTargetFailure(error)
  : error instanceof TeamWorkspaceError
    ? { status: 'fail', code: 'browser_team_workspace_failed',
        teamDetail: publicTeamWorkspaceFailure(error).detail }
  : { status: 'fail', code: error instanceof DeployedBrowserError ? error.code : 'browser_assertions_failed' }

async function writeClosedReport(path, report) {
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}
async function dispose(response) {
  try { await response?.dispose() } catch { /* Response content is never reported. */ }
}
async function closePage(page) {
  let timer
  try {
    await Promise.race([
      Promise.resolve().then(() => page.close({ runBeforeUnload: false })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new DeployedBrowserError('browser_page_close_failed')), 10_000) }),
    ])
  } finally { clearTimeout(timer) }
}

/** Use this test's normal Playwright cookie jar for team selection in both
 * default and deployed smoke. The helper never manufactures a cookie, selects
 * a first/name-matched team, or exposes the owner/workspace IDs in its result. */
export async function selectBrowserTeamWorkspace({ page, baseURL, ownerId }) {
  let closedFailure
  try {
    const base = new URL(baseURL)
    check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password &&
      page?.request && typeof page.request.get === 'function' &&
      typeof page.request.post === 'function', 'browser_contract_rejected')
    const origin = base.origin
    const json = async (path, body) => {
      const post = body !== undefined
      check(post ? path === '/mikka/api/rpc' && isTeamWorkspaceSwitchRequest(body)
        : isTeamWorkspaceReadPath(path) || path === '/mikka/api/auth/get-session',
      'browser_contract_rejected')
      const url = origin + path
      const options = { headers: { origin, 'cache-control': 'no-store' },
        maxRedirects: 0, failOnStatusCode: false, timeout: 30_000 }
      let response
      try {
        response = post ? await page.request.post(url, { ...options,
          headers: { ...options.headers, 'x-mikka-rpc': '1' }, data: body })
          : await page.request.get(url, options)
        const bytes = await response.body()
        check(response.status() === 200 && response.url() === url, 'browser_team_workspace_failed')
        return JSON.parse(bytes.toString('utf8'))
      } finally { await dispose(response) }
    }
    return await selectTeamWorkspace({ ownerId, json })
  } catch (error) {
    // A default Playwright reporter must not print a transport cause/body.
    // Preserve a closed failure, then throw outside catch without private data.
    closedFailure = publicTeamWorkspaceFailure(error)
  }
  throw new TeamWorkspaceError(closedFailure.detail)
}

/** Runs the unchanged browser assertions only in the explicit deployed-target mode.
 * The page and its request context belong to this single Playwright test.
 * The caller's actual identity assertion marks the normal owner session; no
 * cookie, email, password, user ID or raw failure is retained in this report. */
export async function runDeployedBrowserSmoke({
  page, baseURL, smoke, env = process.env, event, attestation,
  assertTarget = assertDeployedTarget,
  saveReport = report => writeClosedReport(REPORT, report),
  now = Date.now,
}) {
  const report = {
    version: 1, kind: 'production-deployed-browser', targetMode: MODE,
    status: 'blocked', code: null, startedAt: new Date(now()).toISOString(),
    targetBeforeVerified: false, targetAfterVerified: false,
    browserExecuted: false, assertionsPassed: false, pageErrorCount: 0,
    signInAttempted: false, normalSessionObserved: false,
    teamWorkspaceConfirmed: false, teamWorkspaceHash: null, teamAdminMembershipVerified: false,
    teamSelectionBasis: null, teamOwnerAttribution: null, teamWorkspaceFailure: null,
    pageClosed: false, signOutAttempted: false, signOutSucceeded: false,
    anonymousAfterLogout: false, sessionClosed: false,
    cleanupSucceeded: false, cleanupCode: null,
    cleanupScope: 'this-test-context-cookie-session-only',
    unknownSignInOutcome: false,
    screenshotsRecorded: false, traceRecorded: false, videoRecorded: false,
  }
  let originalFailure, failure, listening = false, targetBefore
  const onPageError = () => { report.pageErrorCount++ }
  const scope = Object.freeze({
    signInAttempted() { report.signInAttempted = true },
    identityConfirmed() {
      check(report.signInAttempted, 'browser_session_not_observed')
      report.normalSessionObserved = true
    },
    teamWorkspaceConfirmed(proof) {
      check(report.normalSessionObserved && isConfirmedTeam(proof), 'browser_team_workspace_failed')
      Object.assign(report, projectTeam(proof))
    },
  })
  try {
    check(env.MIKKA_ACCEPTANCE_TARGET_MODE === MODE, 'browser_mode_rejected')
    check(baseURL === ORIGIN || baseURL === ORIGIN + '/', 'browser_origin_rejected')
    check(page && typeof page.close === 'function' && page.request &&
      typeof page.request.post === 'function' && typeof page.request.get === 'function' &&
      typeof smoke === 'function', 'browser_contract_rejected')
    targetBefore = await assertTarget({ env, event, attestation })
    Object.assign(report, projectBinding(targetBefore))
    report.targetBeforeVerified = true
    if (typeof page.on === 'function') { page.on('pageerror', onPageError); listening = true }
    report.browserExecuted = true
    await smoke(scope)
    check(report.normalSessionObserved, 'browser_session_not_observed')
    check(report.teamWorkspaceConfirmed, 'browser_team_workspace_failed')
    report.assertionsPassed = true
  } catch (error) {
    originalFailure = error
    failure = publicFailure(error)
  } finally {
    // A target change or failed assertion never suppresses this test's logout.
    // Failure to close the page must not prevent trying the existing cookie.
    try {
      await closePage(page)
      report.pageClosed = true
    } catch {
      report.cleanupCode = 'browser_page_close_failed'
    }
    if (listening) {
      try { page.off('pageerror', onPageError) } catch { /* Keep only the count. */ }
    }
    if (report.signInAttempted) {
      report.signOutAttempted = true
      let response
      try {
        response = await page.request.post(SIGN_OUT, {
          data: {}, headers: { origin: ORIGIN, 'cache-control': 'no-store' },
          maxRedirects: 0, failOnStatusCode: false, timeout: 10_000,
        })
        await response.body()
        report.signOutSucceeded = response.status() === 200 && response.url() === SIGN_OUT
      } catch { /* No response text or transport message leaves the process. */ }
      finally { await dispose(response) }
      if (!report.signOutSucceeded && !report.cleanupCode) report.cleanupCode = 'browser_signout_failed'
      response = undefined
      try {
        response = await page.request.get(SESSION, {
          headers: { 'cache-control': 'no-store' },
          maxRedirects: 0, failOnStatusCode: false, timeout: 10_000,
        })
        const value = await response.json()
        report.anonymousAfterLogout = response.status() === 200 && response.url() === SESSION && value === null
      } catch { /* An absent witness is failure, not an anonymous session. */ }
      finally { await dispose(response) }
      if (!report.anonymousAfterLogout && !report.cleanupCode) report.cleanupCode = 'browser_session_still_present'
      report.sessionClosed = report.signOutSucceeded && report.anonymousAfterLogout
      report.unknownSignInOutcome = !report.normalSessionObserved
    }
    report.cleanupSucceeded = report.pageClosed && (!report.signInAttempted || report.sessionClosed)
    // Recheck after writers stop and this session is logged out. This also runs
    // after an assertion failure, but cannot replace an earlier failure.
    if (targetBefore) {
      try {
        const targetAfter = await assertTarget({ env, event, attestation: targetBefore })
        check(BINDING_FIELDS.every(key => targetAfter[key] === targetBefore[key]), 'production_reports_invalid')
        report.targetAfterVerified = true
      } catch (error) {
        if (!failure) { originalFailure = error; failure = publicFailure(error) }
      }
    }
    if (!report.cleanupSucceeded && (!failure || failure.status === 'inconclusive')) {
      // A failed cleanup remains failed even if the target also moved afterward.
      failure = { status: 'fail', code: 'browser_cleanup_failed' }
      originalFailure = undefined
    }
    if (failure) {
      report.status = failure.status; report.code = failure.code
      if (failure.teamDetail) report.teamWorkspaceFailure = { code: 'team_workspace_failed', detail: failure.teamDetail }
    } else { report.status = 'pass'; report.code = null }
    report.finishedAt = new Date(now()).toISOString()
    try { await saveReport(report) }
    catch {
      if (!failure) failure = { status: 'fail', code: 'browser_report_failed' }
    }
  }
  if (failure) {
    // Keep the original failing outcome and closed target classification.
    // Do not expose Playwright assertion values, stack causes or response data.
    if (originalFailure instanceof DeployedTargetError) throw new DeployedBrowserError(
      failure.status === 'inconclusive' ? 'browser_target_inconclusive' : 'browser_target_blocked')
    throw new DeployedBrowserError(failure.code)
  }
  return report
}

const REPORT_PATHS = Object.freeze({
  browser: REPORT,
  managed: 'production-workflow-migration-report/report.json',
  mobileDaemon: 'production-transport-proof-report/mobile-daemon.json',
  mcp: 'production-transport-proof-report/mcp.json',
})
const MOBILE_CHECKS = ['deployment', 'sessionOwner', 'mobileHomeOwner', 'publishedActions',
  'enrollment', 'registration', 'deviceOwner', 'schedulingDisabled', 'heartbeat', 'finalDeployment']
const MOBILE_CLEANUP = ['credentialRevoked', 'oldCredentialRejected', 'deviceRemoved',
  'originalDevicesPreserved', 'originalCredentialsPreserved', 'sessionClosed']
const MCP_CLEANUP = ['tokenRevoked', 'tokenRejected', 'clientDeleted', 'clientAbsent',
  'normalSessionClosed', 'sessionAbsent']
const allTrue = (value, keys) => value && keys.every(key => value[key] === true)
const emptyArray = value => Array.isArray(value) && value.length === 0

/** A present artifact or a successful previous step is not completion evidence. */
export async function verifyDeployedProductionReports({
  env = process.env, event, attestation, reports,
  assertTarget = assertDeployedTarget, now = Date.now,
}) {
  check(env.MIKKA_ACCEPTANCE_TARGET_MODE === MODE, 'browser_mode_rejected')
  for (const name of Object.keys(REPORT_PATHS)) {
    const report = reports?.[name]
    check(report && typeof report === 'object', 'production_report_missing')
    check(BINDING_FIELDS.every(key => report[key] === attestation?.[key]) &&
      report.targetMode === MODE, 'production_report_binding_mismatch')
  }
  const { browser, managed, mobileDaemon, mcp } = reports
  for (const report of Object.values(reports)) {
    check(isConfirmedTeam(report) && report.teamWorkspaceHash === browser.teamWorkspaceHash,
      'production_report_not_passed')
  }
  check(browser.status === 'pass' && browser.browserExecuted === true && browser.assertionsPassed === true &&
    browser.normalSessionObserved === true && browser.targetBeforeVerified === true &&
    browser.targetAfterVerified === true, 'production_report_not_passed')
  check(browser.pageClosed === true && browser.signOutSucceeded === true &&
    browser.anonymousAfterLogout === true && browser.sessionClosed === true &&
    browser.cleanupSucceeded === true && browser.unknownSignInOutcome === false, 'production_cleanup_unproven')
  check(managed.status === 'pass' && managed.normalSessionObserved === true &&
    managed.teamWorkspaceConfirmed === true && managed.submissionCount === 1 &&
    managed.cleanupSubmissionCount === 0 && managed.sdkMutations === 0 && managed.cronRequests === 0 &&
    managed.databaseWritesByDriver === 0 && managed.managed &&
    typeof managed.managed === 'object' && managed.managed.coordinatorCompleted === true &&
    managed.managed.dueTimerObserved === true && managed.managed.timerTerminalRequired === false &&
    managed.managed.concurrentReconciliationExcluded === false, 'production_report_not_passed')
  check(managed.sessionClosed === true && managed.futureScheduleConfirmedAbsent === true &&
    managed.futureScheduleEvidence === 'observed-once-definition-and-committed-operation', 'production_cleanup_unproven')
  check(mobileDaemon.status === 'pass' && allTrue(mobileDaemon.checks, MOBILE_CHECKS) &&
    emptyArray(mobileDaemon.errors), 'production_report_not_passed')
  check(allTrue(mobileDaemon.cleanup, MOBILE_CLEANUP), 'production_cleanup_unproven')
  check(mcp.status === 'passed' && emptyArray(mcp.cleanup?.failureCodes) &&
    mcp.teamBindingScope === 'owner-session' && mcp.catalogueWorkspaceDataVerified === false &&
    mcp.toolsInvoked === 0 && mcp.modelCalls === 0, 'production_report_not_passed')
  check(allTrue(mcp.cleanup, MCP_CLEANUP) && mcp.cleanup?.unresolvedResources === false, 'production_cleanup_unproven')
  // A fresh live alias/deployment/public-version proof is the final operation.
  // Main may have advanced; this verifies the declared deployed target, never a
  // rewritten event or a supplied GITHUB_SHA.
  const finalTarget = await assertTarget({ env, event, attestation })
  check(BINDING_FIELDS.every(key => finalTarget[key] === attestation[key]), 'production_report_binding_mismatch')
  return {
    version: 1, kind: 'production-deployed-target-completion', ...projectBinding(finalTarget),
    ...projectTeam(browser),
    teamBindingScope: 'authenticated-sessions', mcpCatalogueWorkspaceDataVerified: false,
    status: 'pass', code: null, completedAt: new Date(now()).toISOString(),
    browserPassed: true, managedWorkflowPassed: true, mobileDaemonPassed: true, mcpPassed: true,
    allRequiredCleanupProven: true, finalTargetVerified: true,
    noToolsCallOrModelByMcp: true,
    currentMainEqualityRequired: false,
    originalPublicationAndAutomaticAcceptanceGuardsUnchanged: true,
  }
}
async function readClosedJson(path) {
  let bytes
  try { bytes = await readFile(path) } catch { throw new DeployedBrowserError('production_report_missing') }
  check(bytes.byteLength <= 524_288, 'production_reports_invalid')
  try { return JSON.parse(bytes.toString('utf8')) } catch { throw new DeployedBrowserError('production_reports_invalid') }
}
async function main() {
  check(process.argv.length === 3 && process.argv[2] === '--verify-all', 'production_reports_invalid')
  let result
  try {
    const event = await readClosedJson(process.env.GITHUB_EVENT_PATH ?? '')
    const attestation = await readClosedJson('production-read-cache-report/attestation.json')
    const reports = Object.fromEntries(await Promise.all(Object.entries(REPORT_PATHS)
      .map(async ([name, path]) => [name, await readClosedJson(path)])))
    result = await verifyDeployedProductionReports({ event, attestation, reports })
  } catch (error) {
    const failure = publicFailure(error)
    result = { version: 1, kind: 'production-deployed-target-completion', targetMode: MODE,
      status: failure.status, code: failure.code, finalTargetVerified: false }
    process.exitCode = 1
  }
  await writeClosedReport('production-deployed-target-report/report.json', result)
  console.log(JSON.stringify({ status: result.status, code: result.code, finalTargetVerified: result.finalTargetVerified }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ status: 'fail', code: 'production_reports_invalid', finalTargetVerified: false }))
    process.exitCode = 1
  })
}
