import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { runGroupRoutingBoundaries } from './group-routing-boundaries.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const TOKEN = /^[A-Za-z0-9_.:-]{1,180}$/
const digest = value => createHash('sha256').update(value).digest('hex')
class BundleError extends Error { constructor(code) { super('routing_bundle_' + code) } }
const check = (ok, code) => { if (!ok) throw new BundleError(code) }
const safeError = error => error instanceof BundleError ? error.message : 'routing_bundle_unconfirmed'

/** Prepared export only: importing this file never logs in or calls a model.
 * The caller supplies bytes from a verified, complete core artifact and its
 * expected SHA256. This adapter checks those bytes and live scope; it does not
 * infer GitHub artifact provenance merely from a matching caller-supplied hash. */
export async function runGroupRoutingBundle({ env = process.env, fetchImpl = fetch, repo = process.cwd(),
  coreReportJson, coreReportSha256, dependencies, now = Date.now, wait = delay,
  verifySource = () => { check(!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' }).trim(), 'source_dirty'); return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() } } = {}) {
  const revision = env.GROUP_ACCEPTANCE_REVISION, deploymentId = env.GROUP_ACCEPTANCE_DEPLOYMENT
  check(/^[a-f0-9]{40}$/.test(revision ?? '') && /^dpl_[A-Za-z0-9]+$/.test(deploymentId ?? ''), 'fixed_deployment_required')
  check(!env.GROUP_ACCEPTANCE_ORIGIN || env.GROUP_ACCEPTANCE_ORIGIN === ORIGIN, 'origin_rejected')
  check(verifySource() === revision, 'source_revision_mismatch')
  check(typeof coreReportJson === 'string' && Buffer.byteLength(coreReportJson) <= 2 * 1024 * 1024
    && HASH.test(coreReportSha256 ?? '') && digest(coreReportJson) === coreReportSha256, 'core_artifact_digest')
  let core
  try { core = JSON.parse(coreReportJson) } catch { throw new BundleError('core_artifact_shape') }
  check(core?.status === 'pass' && core.group?.status === 'pass' && core.replay?.status === 'complete'
    && core.replayAccounting?.qualityAccepted === true && core.replayAccounting.collectionComplete === true
    && core.expectedDecisionReplays === 24 && core.actualReceiptedDecisionReplays === 24
    && core.completedLogicalDecisionReplays === 24, 'core_acceptance_required')
  check(core.origin === ORIGIN && core.revision === revision && core.deploymentId === deploymentId
    && core.group.revision === revision && core.group.deploymentId === deploymentId, 'core_source_binding')
  check(UUID.test(core.group.conversationId ?? '') && core.fixtureConversationId === core.group.conversationId
    && UUID.test(core.group.fixtureId ?? '') && UUID.test(core.group.workspaceId ?? '')
    && TOKEN.test(core.group.requesterId ?? ''), 'core_fixture_binding')
  const fixture = { exclusive: true, coreBundleStatus: core.status, creationReport: core.group,
    reportSha256: digest(JSON.stringify(core.group)), sourcePin: { revision, deploymentId } }
  const started = now(), deadline = started + 600_000
  const report = { schemaVersion: 1, scope: 'single-run-group-routing-bundle', status: 'failed', revision, deploymentId,
    startedAt: new Date(started).toISOString(), finishedAt: null, group: null, error: null, credentialCleanup: null,
    sessionCleanup: {}, coreEvidence: { sha256: coreReportSha256, fixtureId: core.group.fixtureId,
      conversationId: core.group.conversationId, sourceRevision: core.revision, deploymentId: core.deploymentId,
      artifactProvenanceVerifiedByRunner: false }, cloudCredentialCreated: false, maximumMessages: 8, budgetMs: 600_000 }
  const module = path => import(pathToFileURL(resolve(repo, path)).href)
  const api = dependencies ?? Object.assign({ runGroupRoutingBoundaries }, ...await Promise.all([
    module('scripts/ops/proactive-test-credentials.mjs'), module('scripts/test-model-policy.mjs'),
    module('lib/smoke-account.ts'), module('lib/coordinator/decision.ts')]))
  const email = env.SMOKE_OWNER_EMAIL, password = env.SMOKE_OWNER_PASSWORD
  check(api.isSmokeAccountEmail(email) && password, 'normal_account_required')
  check(typeof api.runGroupRoutingBoundaries === 'function' && typeof api.withTemporaryFlashCredential === 'function'
    && typeof api.assertFlashTestModel === 'function' && api.DECISION_MODEL === 'openai/gpt-6-luna-decisions', 'source_contract')
  let cookie = '', cleanupReceipt
  const transport = scope => {
    const record = report.sessionCleanup[scope] = { loginAttempted: false, loginStatus: null,
      logoutAttempted: false, logoutStatus: null, logoutAcknowledged: false }
    return async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      check(url.origin === ORIGIN && !url.username && !url.password && !url.hash && url.pathname.startsWith('/mikka/'), 'transport_origin_rejected')
      check(now() < deadline, 'budget_exhausted')
      const signal = AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - now())))
      const login = url.pathname === '/mikka/api/auth/sign-in/email' && init.method === 'POST'
      const logout = url.pathname === '/mikka/api/auth/sign-out' && init.method === 'POST'
      if (login) record.loginAttempted = true
      if (logout) record.logoutAttempted = true
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal })
      if (login) record.loginStatus = response.status
      if (logout) { record.logoutStatus = response.status; record.logoutAcknowledged = response.status === 200 }
      return response
    }
  }
  const credentialTransport = transport('temporaryCredentials'), ownerTransport = transport('routingFixture')
  const owner = { request: (path, init = {}) => ownerTransport(ORIGIN + '/mikka' + path, { ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), origin: ORIGIN, 'cache-control': 'no-store', ...(cookie ? { cookie } : {}) } }) }
  const verifyTarget = async ({ signal } = {}) => {
    check(verifySource() === revision, 'source_revision_mismatch')
    const response = await owner.request('/api/version', { method: 'GET', signal })
    check(response.status === 200 && (await response.json())?.build === deploymentId, 'deployment_changed')
  }
  try {
    await verifyTarget()
    const login = await owner.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
    check(login.status === 200, 'login_failed')
    cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    const response = await owner.request('/api/auth/get-session', { method: 'GET' }), session = await response.json()
    check(cookie && response.status === 200 && session?.user?.email?.toLowerCase() === email.toLowerCase()
      && session.user.id === core.group.requesterId, 'session_identity')
    await api.withTemporaryFlashCredential(async cleanup => {
      cleanupReceipt = cleanup
      await verifyTarget()
      const budgetMs = Math.min(555_000, deadline - now() - 45_000)
      check(budgetMs >= 1000, 'budget_exhausted')
      report.group = await api.runGroupRoutingBoundaries({ owner, verifyTarget, assertFlashTestModel: api.assertFlashTestModel,
        decisionModelId: api.DECISION_MODEL, fixture, allowFixtureFlashSelection: true, now, wait, budgetMs })
    }, { env: { ...env, MIKKA_TEST_ACCOUNT_EMAIL: email, MIKKA_TEST_ACCOUNT_PASSWORD: password }, fetchImpl: credentialTransport, cloudExecution: false })
    await verifyTarget()
  } catch (error) { report.error = safeError(error) }
  finally {
    if (cookie) { try { await owner.request('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) } catch {} }
    cookie = ''
    report.credentialCleanup = cleanupReceipt ? { created: cleanupReceipt.created === true, removed: cleanupReceipt.removed === true } : null
    report.finishedAt = new Date(now()).toISOString(); report.elapsedMs = Math.max(0, now() - started)
    report.status = !report.error && report.group?.status === 'passed' && report.elapsedMs <= 600_000
      && cleanupReceipt && (!cleanupReceipt.created || cleanupReceipt.removed)
      && Object.values(report.sessionCleanup).every(session => session.loginStatus === 200
        && session.logoutAttempted && session.logoutAcknowledged && session.logoutStatus === 200) ? 'passed' : 'failed'
  }
  return report
}
