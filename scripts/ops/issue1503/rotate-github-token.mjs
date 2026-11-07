import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSmokeGitHubFixture, SMOKE_USER_ID, OWNER_USER_ID, GITHUB_ACCOUNT_ID, GITHUB_LOGIN, REPOSITORY } from '../issue1503-smoke-github.mjs'
import { renewalFixture } from './renew-github-expiry.mjs'

const WORKSPACE_ID = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const SOURCE_MIN_MS = 10 * 60_000, PREPARATION_MS = 5 * 60_000
const CHILD_MIN_MS = 2 * 60 * 60_000, CHILD_MAX_MS = 4 * 60 * 60_000
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw new Error(`issue1503_github_rotation_${code}`) }
const check = (value, code) => { if (!value) fail(code) }
const iso = value => value instanceof Date ? value.toISOString() : value
const safeCode = error => /^issue1503_github_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'issue1503_github_rotation_dependency_failed'

export function rotationSource(source, now = Date.now()) {
  check(source?.metadata?.userId === OWNER_USER_ID && source.metadata.githubAccountId === GITHUB_ACCOUNT_ID
    && source.metadata.githubLogin === GITHUB_LOGIN && source.githubAccountId === GITHUB_ACCOUNT_ID
    && typeof source.token === 'string' && source.token.length > 0
    && Number.isFinite(Date.parse(source.metadata.updatedAt))
    && Number.isFinite(Date.parse(source.expiresAt)) && iso(source.expiresAt) === source.metadata.expiresAt
    && Date.parse(source.expiresAt) > now + SOURCE_MIN_MS, 'owner_source_not_fresh')
  // Whitelist metadata; never serialize the supplied object or its token.
  return { userId: OWNER_USER_ID, githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN,
    updatedAt: source.metadata.updatedAt, expiresAt: source.metadata.expiresAt,
    hasRefreshToken: source.metadata.hasRefreshToken === true }
}

export function rotationLifetime(providerExpiry, now = Date.now()) {
  const seconds = Math.floor((Math.min(providerExpiry, now + CHILD_MAX_MS) - 10_000 - now) / 1000)
  check(Number.isFinite(providerExpiry) && seconds >= CHILD_MIN_MS / 1000, 'child_validity_insufficient')
  return { expiresIn: seconds, providerExpiry }
}

/** No production I/O on import. All credentials remain in this call or the
 * existing sealed connection store. The original Owner credential is read,
 * never refreshed, rewritten, reset, revoked or copied into Smoke. */
export async function rotateGitHubChild({ fixture, application, appId, store, fetchImpl = fetch,
  now = Date.now, checkpoint = async () => {}, report = {} }) {
  Object.assign(report, { version: 1, issue: 1503, phase: 'github_scoped_child_rotation', mode: 'existing_owner_no_refresh',
    workspaceId: WORKSPACE_ID, smokeUserId: SMOKE_USER_ID, ownerUserId: OWNER_USER_ID,
    startedAt: new Date(now()).toISOString(), status: 'running', changed: false, installAttempted: false })
  let newToken, prepared, installed = false, source, state, provider
  let deadline = Infinity, preparing = false
  const boundedFetch = (url, init) => {
    // Cleanup retains its ordinary 15s timeout after the preparation budget.
    const remaining = deadline - now()
    if (preparing) check(remaining > 0, 'preparation_deadline')
    return fetchImpl(url, { ...init, signal: AbortSignal.any([init.signal,
      ...(preparing ? [AbortSignal.timeout(Math.max(1, Math.min(PREPARATION_MS, remaining)))] : [])].filter(Boolean)) })
  }
  const save = async stage => { report.stage = stage; await checkpoint(report) }
  try {
    state = renewalFixture(fixture); report.before = state
    check(!appId || String(appId) === state.appId, 'app_configuration_mismatch')
    provider = createSmokeGitHubFixture({ application, appId: state.appId, fetchImpl: boundedFetch, now, credentials: {} })
    await store.validateFixture(fixture)
    report.activityBefore = await store.idle()
    await store.matching(state) // Exact old child must remain the recovery anchor.
    source = await store.ownerSourceNoRefresh()
    report.ownerBefore = rotationSource(source, now())
    deadline = now() + PREPARATION_MS; preparing = true
    await save('prepare_new_scoped_child')
    prepared = await provider.prepareChild(source, { minimumSourceValidityMs: SOURCE_MIN_MS, requireSourceProviderExpiry: true,
      onSourceChecked: value => { report.ownerProvider = value },
      onMint: token => { check(hash(token) !== state.tokenSha256 && token !== source.token, 'child_not_distinct'); newToken = token },
      stage: value => { report.providerStage = value } })
    preparing = false
    check(prepared.metadata.repositoryId === state.repositoryId && prepared.metadata.installationId === state.installationId
      && prepared.metadata.appId === state.appId, 'provider_target_changed')
    rotationLifetime(prepared.providerExpiry, now())
    report.newChild = { ...prepared.metadata, tokenSha256: prepared.tokenSha256 }
    await save('replace_exact_idle_smoke_connection')
    report.installAttempted = true
    const after = await store.replace(state, source, prepared, {
      beforeRevoke: async activity => {
        report.activityAtSave = activity
        rotationLifetime(prepared.providerExpiry, now())
        await save('revoke_exact_old_child')
      },
      revokeOld: async token => {
        check(hash(token) === state.tokenSha256, 'old_child_changed')
        report.oldChildRevocation = await provider.revokeConfirmed(token)
        report.oldConnectionUsable = false
        await save('old_child_revoked')
      },
      prepared: async after => { report.preparedAfter = after; await save('commit_new_child') },
    })
    installed = true; report.changed = true; report.after = after
    await save('new_child_committed')
    const observed = await store.observe(state, prepared)
    check(observed.kind === 'new' && JSON.stringify(observed.state) === JSON.stringify(after), 'new_connection_readback_changed')
    report.ownerAfter = await store.ownerMetadata()
    check(JSON.stringify(report.ownerAfter) === JSON.stringify(report.ownerBefore), 'owner_connection_changed')
    report.ownerUnchanged = true
    report.activityAfter = await store.idle()
    report.status = 'passed'
  } catch (error) {
    preparing = false
    report.status = 'incomplete'; report.code = safeCode(error)
    if (report.installAttempted && prepared) {
      try {
        const observed = await store.observe(state, prepared)
        report.commitObservation = observed.kind
        if (observed.kind === 'new') {
          installed = true; report.changed = true; report.after = observed.state
        } else if (observed.kind === 'old') {
          installed = false; report.changed = false
          report.recovery = report.oldChildRevocation ? 'mint_again_against_revoked_old_cas' : 'old_connection_retained'
        } else {
          report.commitUnconfirmed = true
        }
      } catch { report.commitUnconfirmed = true }
    }
    // A possibly committed new credential must never be revoked speculatively.
    if (newToken && !installed && !report.commitUnconfirmed) {
      try { report.newChildCleanup = await provider.revokeConfirmed(newToken) }
      catch (cleanupError) { report.newChildCleanup = { confirmed: false, code: safeCode(cleanupError),
        providerExpiresAt: prepared?.metadata.providerExpiresAt ?? null, tokenSha256: hash(newToken) } }
    }
  } finally {
    source = undefined; newToken = undefined; prepared = undefined
    report.completedAt = new Date(now()).toISOString()
    await checkpoint(report)
  }
  return report
}

export async function runRotation(env = process.env) {
  const report = { status: 'incomplete' }
  const inputPath = resolve(env.MIKKA_1503_FIXTURE_STATE_FILE ?? 'scripts/ops/issue1503/fixture-state.json')
  const reportPath = resolve(env.MIKKA_1503_GITHUB_ROTATION_REPORT ?? 'issue1503-report/github-token-rotation.json')
  const outputPath = resolve(env.MIKKA_1503_ROTATED_FIXTURE_STATE_FILE ?? 'issue1503-report/renewed-fixture-state.json')
  check(inputPath !== reportPath && inputPath !== outputPath && reportPath !== outputPath, 'output_overwrites_input')
  let pool, workspacePool, fixture
  const checkpoint = async value => {
    await mkdir(resolve(reportPath, '..'), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    if (value.after && fixture) {
      await mkdir(resolve(outputPath, '..'), { recursive: true })
      await writeFile(outputPath, `${JSON.stringify({ ...fixture, githubSetup: value.after }, null, 2)}\n`, { mode: 0o600 })
    }
  }
  try {
    const text = await readFile(inputPath, 'utf8')
    fixture = JSON.parse(text); renewalFixture(fixture)
    report.inputFixtureSha256 = hash(text)
    const application = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
    check(application.clientId && application.clientSecret, 'app_not_configured')
    const database = await import('../../../lib/db/index.ts')
    pool = database.pool; workspacePool = (await import('../../../lib/workspace-db.ts')).workspacePool
    const connection = await import('../../../lib/github/connection.ts')
    const { createRotationStore } = await import('./rotate-github-token-store.mjs')
    const store = createRotationStore({ pool, workspacePool, withDatabaseClient: database.withDatabaseClient,
      connection, lifetime: rotationLifetime })
    await rotateGitHubChild({ fixture, application, appId: env.GITHUB_APP_ID, store, checkpoint, report })
  } catch (error) {
    report.status = 'incomplete'; report.code = safeCode(error)
    report.completedAt = new Date().toISOString()
  } finally {
    await Promise.allSettled([pool?.end(), workspacePool?.end()])
    await checkpoint(report)
    // This object is built only from whitelisted metadata and locally chosen codes.
    console.log(JSON.stringify(report))
  }
  if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runRotation() }
  catch (error) { console.error(JSON.stringify({ status: 'incomplete', code: safeCode(error) })); process.exitCode = 1 }
}
