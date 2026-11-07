// Temporary #1505 operations helper. No issue, Profile, model task or VM creation.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

export const SOURCE = 'fb173dcbdc2f2f02ebb98be2edf80df975c58d7f'
export const TREE = '4a5724298b2a1a2a3b5c9ad1d1c9185fa5e03a67'
export const BRANCH = 'ops/1505-diagnostic-window-fb173d'
export const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
export const TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
export const KEY = 'MIKKA_CLOUD_DIAGNOSTIC_WINDOW'
export const ORIGIN = 'https://app.aspectlylabs.com'
export const GO = 'root-reviewed-1505-diagnostic-window-fb173d'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9_-]{1,200}$/
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { windowCode: code }) }
function closedError(error) {
  if (error?.windowCode) return { code: error.windowCode, ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}) }
  const status = /^startup_http_([1-5][0-9]{2})$/.exec(error?.message ?? '')
  return { code: error?.code === 'team_workspace_failed' ? 'team_workspace_failed' : 'normal_api_operation_failed',
    ...(status ? { httpStatus: Number(status[1]) } : {}) }
}

async function platform(path, { token, fetchImpl, method = 'GET', body, allow404 = false }) {
  check(typeof token === 'string' && token.length > 0, 'platform_token_missing')
  const url = new URL(path, 'https://api.vercel.com'); url.searchParams.set('teamId', TEAM)
  let response
  try { response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }) }
  catch (cause) { throw Object.assign(new Error(method === 'POST' ? 'window_create_uncertain' : 'platform_transport_failed', { cause }),
    { windowCode: method === 'POST' ? 'window_create_uncertain' : 'platform_transport_failed' }) }
  if (allow404 && response.status === 404) return { status: 404, data: null }
  if (!response.ok) throw Object.assign(new Error('platform_request_refused'), { windowCode: 'platform_request_refused', httpStatus: response.status })
  const data = response.status === 204 ? null : await response.json().catch(() => null)
  check(response.status === 204 || data !== null, method === 'POST' ? 'window_create_uncertain' : 'platform_response_invalid')
  return { status: response.status, data }
}
const ownRow = row => row?.key === KEY && Array.isArray(row.target) && row.target.length === 1 && row.target[0] === 'production'
  && !row.gitBranch && !row.customEnvironmentIds?.length && ID.test(row.id ?? '')

export async function prepareWindow({ env, helpers, fetchImpl = fetch, now = Date.now, save = async () => {} }) {
  const report = { version: 1, issue: 1505, sourceCommit: SOURCE, sourceTree: TREE, projectId: PROJECT, teamId: TEAM,
    workflowRunId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, workflowHead: env.GITHUB_SHA,
    helperBranch: BRANCH, fixtureId: randomUUID(), startedAt: new Date(now()).toISOString(), status: 'running',
    scope: 'dedicated_bot_repository_window', modelsDispatched: 0, virtualMachinesCreated: 0, profilesCreated: 0,
    cleanup: { botStopped: false, workspaceRestored: false, signedOut: false, errors: [] }, window: null }
  const client = helpers.createSessionClient(ORIGIN, fetchImpl)
  let stage = 'configuration_preflight', loginAttempted = false, requesterId, workspaceId, originalWorkspaceId, accountReady = false
  const call = (path, options = {}) => platform(path, { token: env.VERCEL_TEAM_TOKEN, fetchImpl, ...options })
  try {
    const { data: listed } = await call(`/v10/projects/${PROJECT}/env`)
    check(Array.isArray(listed.envs) && !listed.envs.some(row => row.key === KEY), 'existing_window_not_owned')
    report.windowKeyAbsentBefore = true
    try {
      stage = 'normal_login'
      const { email, password } = helpers.smokeAcceptanceAccount(env)
      loginAttempted = true
      const response = await client.request('/api/auth/sign-in/email', post({ email, password, rememberMe: false }))
      check(response.ok, 'normal_login_refused')
      const session = await client.json('/api/auth/get-session')
      check(session.user?.email?.toLowerCase() === email.toLowerCase() && typeof session.user?.id === 'string'
        && session.user.id.length > 0 && session.user.id.length <= 128, 'session_identity_mismatch')
      requesterId = session.user.id; report.requesterHash = hash(requesterId)
      const version = await client.json('/api/version')
      check(/^[0-9a-f]{40}$/.test(version.build ?? ''), 'application_version_invalid')
      report.applicationAtPreparation = version.build
      stage = 'normal_team_selection'
      const scope = await helpers.selectAcceptanceTeam(client, { ownerId: requesterId }, value => { originalWorkspaceId = value })
      workspaceId = scope.workspaceId
      check(UUID.test(workspaceId) && scope.adminId !== requesterId && scope.evidence?.teamAdminMembershipVerified === true, 'shared_team_not_verified')
      report.workspaceHash = hash(workspaceId); report.normalSessionVerified = true; report.sharedTeamVerified = true
      stage = 'normal_bot_creation'
      report.botName = `测试1505 ${report.fixtureId.slice(0, 8)}`
      report.botCreationAttempted = true
      // Persist the exact recovery name before the potentially ambiguous POST.
      // A missing response ID must never be interpreted as proof of no write.
      await save(report)
      // Record the returned ID before the next GET so a failed validation cannot lose the created fixture.
      const created = await client.rpc('bots.createBot', [{ name: report.botName,
        color: 'gris', shape: 'cercle', model: null, repository: null }])
      check(UUID.test(created.id ?? ''), 'bot_create_response_invalid')
      report.botId = created.id; report.botRetention = 'retained_no_delete_api'
      await save(report)
      await helpers.acceptanceBot(client, report.botId, report.fixtureId)
      report.botOwnedAndNamed = true; accountReady = true
    } catch (error) { report.error = { stage, ...closedError(error) } }
    finally {
      if (report.botId) {
        try { await client.rpc('coordinator.stopCoordinatorTurn', [report.botId]); report.cleanup.botStopped = true }
        catch (error) { report.cleanup.errors.push({ stage: 'stop_created_bot', ...closedError(error) }) }
      }
      if (originalWorkspaceId && requesterId) {
        try { await helpers.restoreAcceptanceWorkspace(client, requesterId, originalWorkspaceId); report.cleanup.workspaceRestored = true }
        catch (error) { report.cleanup.errors.push({ stage: 'restore_workspace', ...closedError(error) }) }
      }
      if (loginAttempted) {
        try { const response = await client.request('/api/auth/sign-out', post({})); check(response.ok, 'normal_signout_refused'); report.cleanup.signedOut = true }
        catch (error) { report.cleanup.errors.push({ stage: 'sign_out', ...closedError(error) }) }
      }
      client.clear()
    }
    check(accountReady && !report.error && report.cleanup.botStopped && report.cleanup.workspaceRestored
      && report.cleanup.signedOut && !report.cleanup.errors.length, 'normal_session_cleanup_incomplete')
    stage = 'window_creation'
    const expiresAt = new Date(now() + 120 * 60_000).toISOString()
    const value = JSON.stringify({ version: 1, requesterId, workspaceId, botId: report.botId,
      repository: 'alexj11324/mikka-handoff', expiresAt })
    report.window = { key: KEY, valueSha256: hash(value), expiresAt, durationMinutes: 120,
      writeAttempted: false, creationAcknowledged: false, readbackVerified: false,
      requiresSubsequentWebBuild: true, activeDeploymentRevoked: false }
    await save(report)
    // Recheck at the write boundary. This helper never upserts or retries a POST.
    const { data: current } = await call(`/v10/projects/${PROJECT}/env`)
    check(Array.isArray(current.envs) && !current.envs.some(row => row.key === KEY), 'existing_window_not_owned')
    report.window.writeAttempted = true; await save(report)
    const { data: createdEnv } = await call(`/v10/projects/${PROJECT}/env`, { method: 'POST', body: {
      key: KEY, value, type: 'encrypted', target: ['production'] } })
    report.window.creationAcknowledged = true
    const direct = ownRow(createdEnv) ? createdEnv : ownRow(createdEnv?.created?.[0]) ? createdEnv.created[0] : null
    if (direct) report.window.id = direct.id
    await save(report)
    const { data: readList } = await call(`/v10/projects/${PROJECT}/env`)
    const rows = (readList.envs ?? []).filter(row => row.key === KEY)
    check(rows.length === 1 && ownRow(rows[0]) && (!report.window.id || rows[0].id === report.window.id), 'window_metadata_mismatch')
    report.window.id = rows[0].id; await save(report)
    const { data: read } = await call(`/v1/projects/${PROJECT}/env/${encodeURIComponent(report.window.id)}`)
    check(read.value === value, 'window_value_mismatch')
    report.window.readbackVerified = true; report.status = 'prepared'
  } catch (error) {
    report.error ??= { stage, ...closedError(error) }; report.status = 'failed'
    report.recovery = { preserveHelperRef: true, repeatPreparationAutomatically: false,
      botWriteMayExist: report.botCreationAttempted === true, windowWriteMayExist: report.window?.writeAttempted === true }
  } finally {
    client.clear(); report.finishedAt = new Date(now()).toISOString()
    try { await save(report) }
    catch { report.status = 'failed'; report.error ??= { stage: 'save_report', code: 'recovery_artifact_write_failed' }
      report.recovery = { preserveHelperRef: true, repeatPreparationAutomatically: false,
        botWriteMayExist: report.botCreationAttempted === true, windowWriteMayExist: report.window?.writeAttempted === true } }
  }
  return report
}

/** Optional later cleanup entry. Exact ID+value, never key-wide removal or immutable-deployment revocation. */
export async function removeOwnedWindow(report, { token, fetchImpl = fetch, now = Date.now }) {
  check(report?.version === 1 && report.issue === 1505 && report.sourceCommit === SOURCE && report.sourceTree === TREE
    && report.projectId === PROJECT && report.teamId === TEAM && report.window?.key === KEY
    && ID.test(report.window.id ?? '') && SHA.test(report.window.valueSha256 ?? '')
    && Number.isFinite(Date.parse(report.window.expiresAt)), 'cleanup_record_invalid')
  const call = (path, options = {}) => platform(path, { token, fetchImpl, ...options })
  const id = report.window.id
  const { data: listed } = await call(`/v10/projects/${PROJECT}/env`)
  const rows = (listed.envs ?? []).filter(row => row.key === KEY || row.id === id)
  check(rows.length <= 1, 'cleanup_window_changed')
  if (rows.length) {
    check(rows[0].id === id && ownRow(rows[0]), 'cleanup_window_changed')
    const { data: actual } = await call(`/v1/projects/${PROJECT}/env/${encodeURIComponent(id)}`)
    check(typeof actual.value === 'string' && hash(actual.value) === report.window.valueSha256, 'cleanup_window_changed')
    await call(`/v9/projects/${PROJECT}/env/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  const byId = await call(`/v1/projects/${PROJECT}/env/${encodeURIComponent(id)}`, { allow404: true })
  const { data: after } = await call(`/v10/projects/${PROJECT}/env`)
  check(byId.status === 404 && Array.isArray(after.envs) && !after.envs.some(row => row.key === KEY || row.id === id), 'cleanup_absence_unconfirmed')
  return { key: KEY, id, projectEnvironmentRemoved: true, idReadbackStatus: 404, keyAbsent: true,
    activeDeploymentRevoked: false, originalExpiresAt: report.window.expiresAt,
    expirationDeadlinePassedAtObservation: now() >= Date.parse(report.window.expiresAt), observedAt: new Date(now()).toISOString() }
}

async function main() {
  const [mode, output, input] = process.argv.slice(2)
  check(process.env.DIAGNOSTIC_WINDOW_GO === GO && process.env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && process.env.GITHUB_RUN_ATTEMPT === '1'
    && process.env.GITHUB_REF === `refs/heads/${mode === 'remove' ? BRANCH + '-cleanup' : BRANCH}`, 'execution_not_reviewed')
  check(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === SOURCE
    && execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim() === TREE, 'source_not_pinned')
  check(['prepare', 'remove'].includes(mode) && typeof output === 'string' && output.length > 0, 'arguments_invalid')
  const save = async data => { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(output, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }) }
  let report
  if (mode === 'prepare') {
    const helpers = await import(pathToFileURL(resolve('scripts/acceptance/cloud-startup.mjs')).href)
    report = await prepareWindow({ env: process.env, helpers, save })
    if (report.status !== 'prepared') process.exitCode = 1
  } else {
    check(typeof input === 'string', 'cleanup_record_missing')
    report = await removeOwnedWindow(JSON.parse(await readFile(input, 'utf8')), { token: process.env.VERCEL_TEAM_TOKEN })
    await save(report)
  }
  console.log(JSON.stringify({ status: report.status ?? 'project_window_removed', sourceCommit: SOURCE,
    fixtureId: report.fixtureId ?? null, botId: report.botId ?? null, window: report.window ?? null,
    botName: report.botName ?? null, botCreationAttempted: report.botCreationAttempted === true, recovery: report.recovery ?? null,
    error: report.error ?? null, cleanupErrors: report.cleanup?.errors ?? [],
    modelsDispatched: 0, virtualMachinesCreated: 0, profilesCreated: 0 }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.log(JSON.stringify({ status: 'failed', ...closedError(error), modelsDispatched: 0, virtualMachinesCreated: 0, profilesCreated: 0 })); process.exitCode = 1
})
