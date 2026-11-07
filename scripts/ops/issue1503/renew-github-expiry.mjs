import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SMOKE_USER_ID, OWNER_USER_ID, GITHUB_ACCOUNT_ID, GITHUB_LOGIN, REPOSITORY } from '../issue1503-smoke-github.mjs'

// One authorized expiry extension of the same official scoped child token.
// Importing this module performs no IO. Tokens and provider bodies stay in memory.
const WORKSPACE_ID = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const MAX_MS = 4 * 60 * 60_000, MIN_MS = 2 * 60 * 60_000, MARGIN_MS = 10_000
const PERMISSIONS = { metadata: 'read', contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', actions: 'read' }
const ACTIVE = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']
const hash = value => createHash('sha256').update(value).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => /^(?:[1-9]\d*)$/.test(String(value)) && (typeof value !== 'number' || Number.isSafeInteger(value))
const fail = code => { throw new Error(`issue1503_github_renewal_${code}`) }
const check = (value, code) => { if (!value) fail(code) }
const iso = value => value instanceof Date ? value.toISOString() : value
const identity = value => check(object(value) && String(value.id) === GITHUB_ACCOUNT_ID && value.login === GITHUB_LOGIN && value.type === 'User', 'identity_mismatch')

export function renewalFixture(input) {
  const state = input?.githubSetup
  check(input?.issue === 1503 && input.workspaceId === WORKSPACE_ID && input.ownerUserId === OWNER_USER_ID && input.smokeUserId === SMOKE_USER_ID
    && state?.version === 1 && state.issue === 1503 && state.userId === SMOKE_USER_ID && state.ownerUserId === OWNER_USER_ID
    && state.githubAccountId === GITHUB_ACCOUNT_ID && state.githubLogin === GITHUB_LOGIN && state.repository === REPOSITORY
    && id(state.appId) && id(state.repositoryId) && id(state.installationId) && /^[a-f0-9]{64}$/.test(state.tokenSha256 ?? '')
    && typeof state.checkTokenScopeConfirmed === 'boolean' && Number.isInteger(state.listedRepositoryCount) && state.listedRepositoryCount >= 1
    && Number.isFinite(Date.parse(state.providerExpiresAt)) && Number.isFinite(Date.parse(state.connectionExpiresAt))
    && Number.isFinite(Date.parse(state.connectionUpdatedAt)) && Date.parse(state.connectionUpdatedAt) < Date.parse(state.connectionExpiresAt)
    && Date.parse(state.connectionExpiresAt) <= Date.parse(state.providerExpiresAt), 'fixture_state_mismatch')
  return state
}

export function renewalConnection(row, state) {
  check(row?.userId === SMOKE_USER_ID && row.githubAccountId === GITHUB_ACCOUNT_ID && row.githubLogin === GITHUB_LOGIN
    && row.refreshToken === null && row.refreshTokenExpiresAt === null
    && iso(row.updatedAt) === state.connectionUpdatedAt && iso(row.accessTokenExpiresAt) === state.connectionExpiresAt,
  'connection_changed')
}

/** Check-token may omit installation scope and expires_at. The original mint
 * receipt remains the scope/expiry ceiling for the unchanged token fingerprint. */
export function renewalAuthorization(state, clientId, checked, user, repository, now = Date.now()) {
  check(object(checked) && checked.app?.client_id === clientId, 'app_mismatch')
  if (checked.app.id != null) check(id(checked.app.id) && String(checked.app.id) === state.appId, 'app_mismatch')
  if (checked.token != null && checked.token !== '') check(typeof checked.token === 'string' && hash(checked.token) === state.tokenSha256, 'token_changed')
  identity(user)
  if (checked.user != null) identity(checked.user)
  // Nonempty OAuth scopes would contradict this known GitHub App child token.
  if (checked.scopes != null) check(Array.isArray(checked.scopes) && checked.scopes.length === 0, 'unexpected_oauth_scopes')
  const installation = checked.installation
  const scopeMetadataAvailable = installation != null
  if (scopeMetadataAvailable) {
    check(object(installation) && installation.repository_selection === 'selected', 'scope_not_selected')
    const permissions = installation.permissions
    check(object(permissions) && Object.keys(PERMISSIONS).every(key => permissions[key] === PERMISSIONS[key])
      && Object.keys(permissions).every(key => permissions[key] === 'none' || permissions[key] === PERMISSIONS[key]), 'scope_permissions_changed')
    if (installation.account != null) identity(installation.account)
    if (installation.id != null) check(String(installation.id) === state.installationId, 'installation_changed')
    if (installation.app_id != null) check(String(installation.app_id) === state.appId, 'app_mismatch')
  }
  check(object(repository) && String(repository.id) === state.repositoryId && repository.full_name === REPOSITORY
    && repository.permissions?.push === true && repository.archived === false && repository.disabled !== true, 'repository_changed')
  const originalExpiry = Date.parse(state.providerExpiresAt)
  const checkedExpiry = checked.expires_at == null ? originalExpiry : Date.parse(checked.expires_at)
  const providerExpiry = Math.min(originalExpiry, checkedExpiry)
  check(Number.isFinite(providerExpiry) && providerExpiry > now + MIN_MS + MARGIN_MS, 'provider_validity_insufficient')
  return { appId: state.appId, liveUserConfirmed: true, repositoryPushConfirmed: true,
    scopeMetadataAvailable, scopeMetadataValidated: scopeMetadataAvailable,
    scopeEvidence: scopeMetadataAvailable ? 'original_scoped_mint_and_checked_installation' : 'original_scoped_mint_and_unchanged_token_sha256',
    providerExpirySource: checked.expires_at == null ? 'original_scoped_mint_receipt' : 'original_scoped_mint_and_check_min',
    providerExpiresAt: new Date(providerExpiry).toISOString() }
}

export function renewalDuration(state, evidence, now = Date.now()) {
  const providerExpiry = Date.parse(evidence.providerExpiresAt)
  const target = Math.min(providerExpiry, now + MAX_MS) - MARGIN_MS
  const expiresIn = Math.floor((target - now) / 1000)
  check(expiresIn >= MIN_MS / 1000 && target > Date.parse(state.connectionExpiresAt), 'extension_unavailable')
  return { expiresIn, providerExpiry, maximumStoredExpiry: target + MARGIN_MS }
}

async function githubRequest(path, authorization, body) {
  let response
  try {
    response = await fetch(`https://api.github.com${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(15_000), headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        'user-agent': 'Mikka-Issue-1503-Authorized-Expiry-Renewal', authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  } catch { fail('provider_transport') }
  if (response.status !== 200) { await response.body?.cancel().catch(() => {}); fail(`provider_http_${response.status}`) }
  let result
  try { result = await response.json() } catch { fail('provider_schema') }
  check(object(result), 'provider_schema')
  return result
}

async function idle(query) {
  const { rows: [row] } = await query.query(`WITH fixture_bots AS (SELECT id FROM bots WHERE "workspaceId"=$1),
    fixture_tasks AS (SELECT id,"issueId",status FROM factory_tasks WHERE "botId" IN (SELECT id FROM fixture_bots)),
    fixture_runs AS (SELECT r.id,r.status FROM agent_runs r WHERE r."botId" IN (SELECT id FROM fixture_bots)
      OR EXISTS(SELECT 1 FROM thread_machines m WHERE m."runId"=r.id AND m."workspaceId"=$1)
      OR EXISTS(SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id AND b."workspaceId"=$1)
      OR EXISTS(SELECT 1 FROM factory_attempts a WHERE a."runId"=r.id AND a."taskId" IN (SELECT id FROM fixture_tasks)))
    SELECT
      (SELECT count(*) FROM fixture_runs WHERE status=ANY($2::text[])) AS "activeRuns",
      (SELECT count(*) FROM fixture_tasks WHERE status IN ('pending','running','waiting')) AS "pendingFactoryTasks",
      (SELECT count(*) FROM bot_subagents WHERE "workspaceId"=$1 AND status IN ('queued','running','needs_you')) AS "pendingSubagents",
      (SELECT count(*) FROM coordinator_sessions WHERE "botId" IN (SELECT id FROM fixture_bots)
        AND ("leaseUntil">now() OR ("leaseHolder" IS NOT NULL AND "leaseUntil" IS NULL))) AS "coordinatorLeases",
      (SELECT count(*) FROM run_publications WHERE ("runId" IN (SELECT id FROM fixture_runs)
        OR "issueId" IN (SELECT "issueId" FROM fixture_tasks))
        AND (status IN ('pending','processing') OR "leaseExpiresAt">now())) AS "pendingPublications",
      (SELECT count(*) FROM factory_merges WHERE "taskId" IN (SELECT id FROM fixture_tasks) AND status='merging') AS "pendingMerges"`,
  [WORKSPACE_ID, ACTIVE])
  const counts = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]))
  check(Object.values(counts).every(value => Number.isSafeInteger(value) && value === 0), 'fixture_work_active')
  return counts
}

async function matching(query, state, locked = false) {
  // Timestamp predicates are evaluated by Postgres, preserving sub-ms CAS.
  const { rows: [row] } = await query.query(`SELECT "userId","githubAccountId","githubLogin","accessToken","refreshToken",
    "accessTokenExpiresAt","refreshTokenExpiresAt","updatedAt" FROM github_connections
    WHERE "userId"=$1 AND "updatedAt"=$2::timestamptz AND "accessTokenExpiresAt"=$3::timestamptz${locked ? ' FOR UPDATE' : ''}`,
  [SMOKE_USER_ID, state.connectionUpdatedAt, state.connectionExpiresAt])
  renewalConnection(row, state)
  return row
}

export async function runRenewal() {
  const report = { version: 1, issue: 1503, phase: 'github_local_expiry_renewal', workspaceId: WORKSPACE_ID,
    smokeUserId: SMOKE_USER_ID, ownerUserId: OWNER_USER_ID, startedAt: new Date().toISOString(), status: 'running', changed: false }
  const path = resolve(process.env.MIKKA_1503_GITHUB_RENEWAL_REPORT ?? 'issue1503-report/github-expiry-renewal.json')
  const fixturePath = resolve(process.env.MIKKA_1503_FIXTURE_STATE_FILE ?? 'scripts/ops/issue1503/fixture-state.json')
  const nextPath = resolve(process.env.MIKKA_1503_RENEWED_FIXTURE_STATE_FILE ?? 'issue1503-report/renewed-fixture-state.json')
  const safeOutputs = path !== fixturePath && nextPath !== fixturePath && path !== nextPath
  const checkpoint = async () => { await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }) }
  let pool, workspacePool, token, stage = 'fixture_state'
  try {
    check(safeOutputs, 'output_overwrites_input')
    const inputText = await readFile(fixturePath, 'utf8'), fixture = JSON.parse(inputText), state = renewalFixture(fixture)
    report.inputFixtureSha256 = hash(inputText); report.before = state
    const clientId = process.env.GITHUB_CLIENT_ID, clientSecret = process.env.GITHUB_CLIENT_SECRET
    check(clientId && clientSecret && (!process.env.GITHUB_APP_ID || process.env.GITHUB_APP_ID === state.appId), 'app_configuration_mismatch')
    const database = await import('../../../lib/db/index.ts')
    pool = database.pool; workspacePool = (await import('../../../lib/workspace-db.ts')).workspacePool
    const connection = await import('../../../lib/github/connection.ts')
    stage = 'validate_fixture'
    const { rows: users } = await pool.query(`SELECT id FROM "user" WHERE (id=$1 AND email=$2) OR (id=$3 AND email=$4)`,
      [OWNER_USER_ID, 'alexjiang20232024@gmail.com', SMOKE_USER_ID, 'alexjiang20232024+mikka-smoke-owner@gmail.com'])
    const { rows: [workspace] } = await workspacePool.query(`SELECT w.id,w."userId",w.kind,w.slug,
      (SELECT count(*) FROM mikka_workspace_members m WHERE m."workspaceId"=w.id) AS members,
      (SELECT count(*) FROM mikka_workspace_members m WHERE m."workspaceId"=w.id AND m.status='active' AND m."userId"=ANY($2::text[])) AS active
      FROM mikka_workspaces w WHERE w.id=$1`, [WORKSPACE_ID, [SMOKE_USER_ID, OWNER_USER_ID]])
    check(users.length === 2 && workspace?.userId === SMOKE_USER_ID && workspace.kind === 'team'
      && workspace.slug === 'issue-1503-factory-smoke-20261106' && Number(workspace.members) === 2 && Number(workspace.active) === 2, 'fixture_membership_changed')
    report.activityBefore = await idle(pool)
    stage = 'matching_existing_child'
    token = await connection.unsealGitHubSecret((await matching(pool, state)).accessToken)
    check(hash(token) === state.tokenSha256, 'token_changed')
    stage = 'official_provider_revalidation'
    const checked = await githubRequest(`/applications/${encodeURIComponent(clientId)}/token`,
      `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, { access_token: token })
    const user = await githubRequest('/user', `Bearer ${token}`)
    const repository = await githubRequest(`/repos/${REPOSITORY}`, `Bearer ${token}`)
    report.provider = renewalAuthorization(state, clientId, checked, user, repository)
    stage = 'normal_connection_save'
    const client = await pool.connect()
    let commitAttempted = false
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      await client.query("SET LOCAL statement_timeout='30s'")
      const locked = await matching(client, state, true)
      check(hash(await connection.unsealGitHubSecret(locked.accessToken)) === state.tokenSha256, 'token_changed')
      report.activityAtSave = await idle(client)
      const duration = renewalDuration(state, report.provider)
      await database.withDatabaseClient(client, () => connection.saveGitHubConnection(SMOKE_USER_ID,
        { githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN }, { access_token: token, expires_in: duration.expiresIn }))
      const { rows: [saved] } = await client.query(`SELECT "userId","githubAccountId","githubLogin","accessToken","refreshToken",
        "accessTokenExpiresAt","refreshTokenExpiresAt","updatedAt" FROM github_connections WHERE "userId"=$1`, [SMOKE_USER_ID])
      check(saved?.accessTokenExpiresAt instanceof Date && saved.updatedAt instanceof Date
        && saved.accessTokenExpiresAt.getTime() <= duration.maximumStoredExpiry && saved.accessTokenExpiresAt.getTime() <= duration.providerExpiry
        && saved.accessTokenExpiresAt.getTime() > Date.parse(state.connectionExpiresAt)
        && hash(await connection.unsealGitHubSecret(saved.accessToken)) === state.tokenSha256, 'stored_credential_mismatch')
      report.after = { ...state, providerExpiresAt: report.provider.providerExpiresAt,
        connectionExpiresAt: saved.accessTokenExpiresAt.toISOString(), connectionUpdatedAt: saved.updatedAt.toISOString() }
      renewalConnection(saved, report.after)
      report.changed = true; report.status = 'prepared'; report.sameToken = true
      await checkpoint() // Exact cleanup receipt survives an ambiguous commit.
      commitAttempted = true
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (commitAttempted) report.commitUnconfirmed = true
      else report.changed = false
      throw error
    } finally { client.release() }
    stage = 'readback'
    check(hash(await connection.unsealGitHubSecret((await matching(pool, report.after)).accessToken)) === state.tokenSha256, 'token_changed')
    report.activityAfter = await idle(pool)
    // A separate safe artifact, never an overwrite of the reviewed input state.
    await mkdir(resolve(nextPath, '..'), { recursive: true })
    await writeFile(nextPath, `${JSON.stringify({ ...fixture, githubSetup: report.after }, null, 2)}\n`, { mode: 0o600 })
    report.renewedFixtureStateWritten = true
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.code = error instanceof Error && /^issue1503_github_renewal_[a-z0-9_]+$/.test(error.message)
      ? error.message : 'issue1503_github_renewal_dependency_failed'
    process.exitCode = 1
  } finally {
    token = undefined
    report.stage = stage; report.completedAt = new Date().toISOString()
    await Promise.allSettled([pool?.end(), workspacePool?.end()])
    if (safeOutputs) await checkpoint()
    console.log(JSON.stringify(report))
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runRenewal()
