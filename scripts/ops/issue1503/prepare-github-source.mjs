import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SMOKE_USER_ID, OWNER_USER_ID, GITHUB_ACCOUNT_ID, GITHUB_LOGIN } from '../issue1503-smoke-github.mjs'
import { renewalFixture } from './renew-github-expiry.mjs'
import { createRotationStore } from './rotate-github-token-store.mjs'
import { rotationLifetime } from './rotate-github-token.mjs'

const WORKSPACE_ID = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
export const SOURCE_FIXTURE_SHA256 = 'd8379ac824e0a813cec76cbabed93cd3430e4af3a4a4411a30e271a311deb21c'
const MIN_SOURCE_MS = 600_000
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw new Error('issue1503_github_source_' + code) }
const check = (value, code) => { if (!value) fail(code) }
const safeCode = error => /^issue1503_github_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'issue1503_github_source_dependency_failed'
const iso = value => value instanceof Date ? value.toISOString() : value
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const rotationOwner = value => ({ userId: value.userId, githubAccountId: value.githubAccountId,
  githubLogin: value.githubLogin, updatedAt: value.updatedAt, expiresAt: value.expiresAt,
  hasRefreshToken: value.hasRefreshToken })

/** This projection intentionally has no access token, refresh token or sealed value. */
export function sourceMetadata(value) {
  check(value?.userId === OWNER_USER_ID && value.githubAccountId === GITHUB_ACCOUNT_ID
    && value.githubLogin === GITHUB_LOGIN && typeof value.hasRefreshToken === 'boolean'
    && Number.isFinite(Date.parse(iso(value.updatedAt))) && Number.isFinite(Date.parse(iso(value.expiresAt)))
    && (value.refreshExpiresAt === null || Number.isFinite(Date.parse(iso(value.refreshExpiresAt)))), 'owner_metadata_invalid')
  return { userId: OWNER_USER_ID, githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN,
    updatedAt: iso(value.updatedAt), expiresAt: iso(value.expiresAt), hasRefreshToken: value.hasRefreshToken,
    refreshExpiresAt: iso(value.refreshExpiresAt) }
}

export function sourceAction(value, now = Date.now()) {
  const metadata = sourceMetadata(value)
  const expiresAt = Date.parse(metadata.expiresAt)
  if (expiresAt > now) {
    check(expiresAt > now + MIN_SOURCE_MS, 'owner_not_expired_but_near_expiry')
    return 'reuse_fresh_source'
  }
  check(metadata.hasRefreshToken && Number.isFinite(Date.parse(metadata.refreshExpiresAt))
    && Date.parse(metadata.refreshExpiresAt) > now, 'owner_refresh_unavailable')
  return 'refresh_expired_source'
}

/** Only the adapter calls the existing product service. No OAuth implementation
 * or token write is present here. A successful service call commits immediately;
 * every assertion after that point is a separate readback, never a rollback. */
export async function prepareGitHubSource({ fixture, store, now = Date.now, checkpoint = async () => {}, report = {} }) {
  Object.assign(report, { version: 1, issue: 1503, phase: 'github_source_preparation',
    workspaceId: WORKSPACE_ID, smokeUserId: SMOKE_USER_ID, ownerUserId: OWNER_USER_ID,
    startedAt: new Date(now()).toISOString(), status: 'running', ownerRefreshAttempted: false, ownerRefreshed: false })
  const save = async stage => { report.stage = stage; await checkpoint(report) }
  try {
    const state = renewalFixture(fixture)
    report.childBefore = state
    await store.validateFixture(fixture)
    report.activityBefore = await store.idle()
    await store.matching(state)
    await save('lock_owner_and_current_child')
    await store.withLockedSource(async locked => {
      report.ownerBefore = sourceMetadata(locked.ownerBefore)
      report.action = sourceAction(report.ownerBefore, now())
      report.activityAtPreparation = await store.idle()
      await store.matching(state)
      await save(report.action)
      if (report.action === 'refresh_expired_source') {
        report.ownerRefreshAttempted = true
        report.ownerRefreshed = null
        await save('standard_owner_refresh_requested')
        await locked.refreshExpiredOwner()
        // Return immediately: no checkpoint or assertion can discard the new
        // provider pair after the product service has successfully stored it.
      }
    })
    report.ownerRefreshed = report.ownerRefreshAttempted
    report.ownerTransactionCommitted = true
    await save('owner_transaction_committed')
    report.ownerAfter = sourceMetadata(await store.observeOwner())
    check(sourceAction(report.ownerAfter, now()) === 'reuse_fresh_source', 'owner_source_not_fresh_after_preparation')
    if (report.ownerRefreshed) {
      check(report.ownerAfter.updatedAt !== report.ownerBefore.updatedAt
        && Date.parse(report.ownerAfter.expiresAt) > Date.parse(report.ownerBefore.expiresAt), 'owner_refresh_readback_mismatch')
      check(report.ownerAfter.hasRefreshToken && Date.parse(report.ownerAfter.refreshExpiresAt) > now(),
        'owner_refresh_pair_readback_missing')
    } else check(same(report.ownerAfter, report.ownerBefore), 'reused_owner_changed')
    await store.matching(state)
    report.activityAfter = await store.idle()
    report.status = 'passed'
  } catch (error) {
    report.status = 'incomplete'; report.code = safeCode(error)
    if (report.ownerRefreshAttempted && !report.ownerTransactionCommitted) {
      report.ownerRefreshed = null
      report.ownerRefreshUnconfirmed = true
      // A new lock read waits for the previous transaction to settle. Metadata
      // can describe the state, but does not justify retrying the provider.
      try {
        report.ownerObservedAfterFailure = sourceMetadata(await store.observeOwner())
        report.ownerMetadataChanged = !same(report.ownerObservedAfterFailure, report.ownerBefore)
      } catch { report.ownerObservation = 'unavailable' }
    }
  } finally {
    report.completedAt = new Date(now()).toISOString()
    await checkpoint(report)
  }
  return report
}

export async function loadSourceStore() {
  const database = await import('../../../lib/db/index.ts')
  const { workspacePool } = await import('../../../lib/workspace-db.ts')
  const connection = await import('../../../lib/github/connection.ts')
  const { githubConnections } = await import('../../../lib/db/schema.ts')
  const { eq, sql } = await import('drizzle-orm')
  const ownerColumns = { userId: githubConnections.userId, githubAccountId: githubConnections.githubAccountId,
    githubLogin: githubConnections.githubLogin, updatedAt: githubConnections.updatedAt,
    expiresAt: githubConnections.accessTokenExpiresAt,
    hasRefreshToken: sql.raw('("refreshToken" IS NOT NULL)'), refreshExpiresAt: githubConnections.refreshTokenExpiresAt }
  const readOwner = tx => tx.select(ownerColumns).from(githubConnections)
    .where(eq(githubConnections.userId, OWNER_USER_ID)).for('update')
  const rotationStore = createRotationStore({ pool: database.pool, workspacePool,
    withDatabaseClient: database.withDatabaseClient, connection, lifetime: rotationLifetime })
  return { ...rotationStore,
    withLockedSource: callback => database.db.transaction(tx => database.withDatabaseTransaction(tx, async () => {
      // Same Owner-before-Smoke lock order as the original child rotation.
      const [owner] = await readOwner(tx)
      await tx.select({ userId: githubConnections.userId }).from(githubConnections)
        .where(eq(githubConnections.userId, SMOKE_USER_ID)).for('update')
      await callback({ ownerBefore: owner,
        refreshExpiredOwner: async () => {
          // The standard service rechecks expiry under this transaction and
          // uses its normal nested savepoint. Its token return stays in memory.
          await connection.githubConnectionToken(OWNER_USER_ID, { minValidityMs: 0 })
        } })
    })),
    observeOwner: () => database.db.transaction(async tx => (await readOwner(tx))[0]),
    close: () => Promise.allSettled([database.pool.end(), workspacePool.end()]),
  }
}

export function preparationConfiguration(env) {
  for (const key of ['DATABASE_URL', 'MIKKA_DATABASE_URL', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'])
    check(typeof env[key] === 'string' && env[key].trim().length > 0, 'configuration_missing')
  check(env.BETTER_AUTH_URL === 'https://app.aspectlylabs.com' && env.NEXT_PUBLIC_APP_URL === 'https://app.aspectlylabs.com',
    'application_origin_invalid')
}

async function writeReport(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

export async function runSourcePreparation(env = process.env, { load = loadSourceStore } = {}) {
  const report = { version: 1, issue: 1503, phase: 'github_source_preparation', status: 'incomplete', stage: 'starting' }
  const inputPath = resolve(env.MIKKA_1503_FIXTURE_STATE_FILE ?? 'scripts/ops/issue1503/fixture-state.json')
  const reportPath = resolve(env.MIKKA_1503_GITHUB_SOURCE_REPORT ?? 'issue1503-report/github-source-preparation.json')
  const checkpoint = value => writeReport(reportPath, value)
  let store, canWriteReport = false
  try {
    check(inputPath !== reportPath, 'output_overwrites_input')
    canWriteReport = true
    await checkpoint(report)
    preparationConfiguration(env)
    const text = await readFile(inputPath, 'utf8')
    check(hash(text) === SOURCE_FIXTURE_SHA256, 'fixture_bytes_changed')
    const fixture = JSON.parse(text)
    renewalFixture(fixture)
    report.inputFixtureSha256 = hash(text)
    report.stage = 'load_normal_services'; await checkpoint(report)
    store = await load()
    await prepareGitHubSource({ fixture, store, checkpoint, report })
  } catch (error) {
    report.status = 'incomplete'; report.code = safeCode(error)
    report.completedAt = new Date().toISOString()
  } finally {
    await store?.close()
    if (canWriteReport) await checkpoint(report)
    console.log(JSON.stringify(report))
  }
  if (report.status !== 'passed') process.exitCode = 1
  return report
}

export function maintenanceSummary(source, rotation) {
  const result = { version: 1, issue: 1503, phase: 'github_standard_refresh_and_child_rotation', status: 'incomplete',
    ownerRefreshAttempted: source?.ownerRefreshAttempted === true,
    ownerRefreshed: typeof source?.ownerRefreshed === 'boolean' ? source.ownerRefreshed : null,
    rotationPhaseOwnerUnchanged: rotation?.ownerUnchanged === true }
  try {
    check(source?.status === 'passed' && source.phase === 'github_source_preparation'
      && rotation?.status === 'passed' && rotation.phase === 'github_scoped_child_rotation', 'maintenance_phase_incomplete')
    check(source.inputFixtureSha256 === SOURCE_FIXTURE_SHA256 && rotation.inputFixtureSha256 === SOURCE_FIXTURE_SHA256
      && source.workspaceId === WORKSPACE_ID && rotation.workspaceId === WORKSPACE_ID
      && source.ownerUserId === OWNER_USER_ID && rotation.ownerUserId === OWNER_USER_ID
      && source.smokeUserId === SMOKE_USER_ID && rotation.smokeUserId === SMOKE_USER_ID
      && same(source.childBefore, rotation.before), 'maintenance_scope_mismatch')
    const before = sourceMetadata(source.ownerBefore), after = sourceMetadata(source.ownerAfter)
    check(typeof source.ownerRefreshed === 'boolean' && source.ownerRefreshAttempted === source.ownerRefreshed
      && source.ownerTransactionCommitted === true && rotation.ownerUnchanged === true
      && same(rotationOwner(after), rotation.ownerBefore) && same(rotation.ownerBefore, rotation.ownerAfter), 'maintenance_owner_evidence_mismatch')
    Object.assign(result, { status: 'passed', workspaceId: WORKSPACE_ID, ownerUserId: OWNER_USER_ID,
      smokeUserId: SMOKE_USER_ID, inputFixtureSha256: SOURCE_FIXTURE_SHA256,
      ownerBefore: before, ownerAfter: after, overallOwnerUnchanged: !source.ownerRefreshed && same(before, after),
      childBefore: source.childBefore, childAfter: rotation.after })
  } catch (error) { result.code = safeCode(error) }
  return result
}

export async function writeMaintenanceSummary(env = process.env) {
  const directory = resolve('issue1503-report')
  let source, rotation
  try { source = JSON.parse(await readFile(resolve(env.MIKKA_1503_GITHUB_SOURCE_REPORT ?? directory + '/github-source-preparation.json'), 'utf8')) } catch { /* Missing phase remains incomplete. */ }
  try { rotation = JSON.parse(await readFile(resolve(env.MIKKA_1503_GITHUB_ROTATION_REPORT ?? directory + '/github-token-rotation.json'), 'utf8')) } catch { /* Missing phase remains incomplete. */ }
  const result = maintenanceSummary(source, rotation)
  await writeReport(resolve(directory, 'github-credential-maintenance.json'), result)
  console.log(JSON.stringify(result))
  if (result.status !== 'passed') process.exitCode = 1
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--summary')) await writeMaintenanceSummary()
    else await runSourcePreparation()
  } catch (error) { console.error(JSON.stringify({ status: 'incomplete', code: safeCode(error) })); process.exitCode = 1 }
}
