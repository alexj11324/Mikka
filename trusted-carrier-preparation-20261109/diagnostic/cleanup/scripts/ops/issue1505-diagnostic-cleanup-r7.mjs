// Temporary #1505 operations helper. Reuse exactly the original idle Bot; no Bot/task/VM creation.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const SOURCE = 'e33e3a91d4011efbe768b11b428a5d152ede744a'
export const TREE = 'b2e36d3351654fceec59fe138a55de31cb155df9'
export const BRANCH = 'ops/1505-renew-window-e33-0018'
export const HELPER_PARENT = 'a9c61594f8294f748cb23130f61779d03f1f2080'
export const HELPER_PARENT_TREE = 'ca473df506cafc97e627bfca8bd0426624e23b2e'
export const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
export const TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
export const KEY = 'MIKKA_CLOUD_DIAGNOSTIC_WINDOW'
export const ORIGIN = 'https://app.aspectlylabs.com'
export const GO = 'root-reviewed-1505-renew-window-e33-0018'
export const ORIGINAL = Object.freeze({
  receiptSha256: '12f6f3758c382dd55c9055b3ab32f9d785c620594c66ad4d49a2030b3ccda8d5',
  helperCommit: '5cd039213a531476cde35500a2498bd3a5089556', helperTree: 'a841f19b0bab028bc386d6c768cce35496ca306b',
  runId: '42366750743', attempt: '1', fixtureId: '620a3647-b039-4909-8562-e3ff867d7324',
  botId: 'fdeea45f-8cb2-450a-96a4-d9a682f71482', botName: '测试1505 620a3647',
})
export const PREVIOUS_RECEIPT_SHA256 = 'cf2628f478a4a91746e9368637dac0e54f3f28bbdf7456bc2d62388aeee39590'
const PREVIOUS_RECEIPT_BASE64 = 'ewogICJ2ZXJzaW9uIjogMSwKICAiaXNzdWUiOiAxNTA1LAogICJzb3VyY2VDb21taXQiOiAiZTMzZTNhOTFkNDAxMWVmYmU3NjhiMTFiNDI4YTVkMTUyZWRlNzQ0YSIsCiAgInNvdXJjZVRyZWUiOiAiYjJlMzZkMzM1MTY1NGZjZWVjNTlmZTEzOGE1NWRlMzFjYjE1NWRmOSIsCiAgInByb2plY3RJZCI6ICJwcmpfVmROejNQMEZtdVJiWktlSTQwaGJDcXdSME5WSCIsCiAgInRlYW1JZCI6ICJ0ZWFtX0M3bHd4VlZ2blVpY0ZsaTYxMTJtdnhwdiIsCiAgIndvcmtmbG93UnVuSWQiOiAiNDI0MjUxMDExNjUiLAogICJhdHRlbXB0IjogIjEiLAogICJ3b3JrZmxvd0hlYWQiOiAiYTljNjE1OTRmODI5NGY3NDhjYjIzMTMwZjYxNzc5ZDAzZjFmMjA4MCIsCiAgImhlbHBlckJyYW5jaCI6ICJvcHMvMTUwNS1yZW5ldy13aW5kb3ctZTMzLTIzMDgiLAogICJmaXh0dXJlSWQiOiAiZThlZGMyYmEtNjdiNi00ZmU2LWEyMDEtOGEzNTkwMjAzNzgzIiwKICAic3RhcnRlZEF0IjogIjIwMjYtMTEtMDdUMjM6MjU6MTkuNDIyWiIsCiAgInN0YXR1cyI6ICJwcmVwYXJlZCIsCiAgInNjb3BlIjogImRlZGljYXRlZF9ib3RfcmVwb3NpdG9yeV93aW5kb3ciLAogICJtb2RlbHNEaXNwYXRjaGVkIjogMCwKICAidmlydHVhbE1hY2hpbmVzQ3JlYXRlZCI6IDAsCiAgInByb2ZpbGVzQ3JlYXRlZCI6IDAsCiAgImJvdENyZWF0aW9uQXR0ZW1wdGVkIjogZmFsc2UsCiAgImJvdFN0b3BBdHRlbXB0ZWQiOiBmYWxzZSwKICAicmV1c2VkRnJvbSI6IHsKICAgICJyZWNlaXB0U2hhMjU2IjogIjEyZjZmMzc1OGMzODJkZDU1YzkwNTViM2FiMzJmOWQ3ODVjNjIwNTk0YzY2YWQ0ZDQ5YTIwMzBiM2NjZGE4ZDUiLAogICAgIndvcmtmbG93UnVuSWQiOiAiNDIzNjY3NTA3NDMiLAogICAgImZpeHR1cmVJZCI6ICI2MjBhMzY0Ny1iMDM5LTQ5MDktODU2Mi1lM2ZmODY3ZDczMjQiCiAgfSwKICAiY2xlYW51cCI6IHsKICAgICJib3RJZGxlVmVyaWZpZWQiOiB0cnVlLAogICAgIndvcmtzcGFjZVJlc3RvcmVkIjogdHJ1ZSwKICAgICJzaWduZWRPdXQiOiB0cnVlLAogICAgImVycm9ycyI6IFtdCiAgfSwKICAid2luZG93IjogewogICAgImtleSI6ICJNSUtLQV9DTE9VRF9ESUFHTk9TVElDX1dJTkRPVyIsCiAgICAidmFsdWVTaGEyNTYiOiAiNjI0MmM0YzM2OGY1ODA1ZjZiY2IzNTM4NTU5YjViMzBiODUxYzRlZTA2MjI4MjNmMTZjMDNiZjgwNDQ4MTRiMyIsCiAgICAiZXhwaXJlc0F0IjogIjIwMjYtMTEtMDhUMDE6MjU6MjMuNDIyWiIsCiAgICAiZHVyYXRpb25NaW51dGVzIjogMTIwLAogICAgIndyaXRlQXR0ZW1wdGVkIjogdHJ1ZSwKICAgICJjcmVhdGlvbkFja25vd2xlZGdlZCI6IHRydWUsCiAgICAicmVhZGJhY2tWZXJpZmllZCI6IHRydWUsCiAgICAicmVxdWlyZXNTdWJzZXF1ZW50V2ViQnVpbGQiOiB0cnVlLAogICAgImFjdGl2ZURlcGxveW1lbnRSZXZva2VkIjogZmFsc2UsCiAgICAiaWQiOiAiWkxwdDBpN0NUTmxrNVhGUiIKICB9LAogICJ3aW5kb3dLZXlBYnNlbnRCZWZvcmUiOiB0cnVlLAogICJyZXF1ZXN0ZXJIYXNoIjogImI4MjNiYTFjNTcyOTc2OGIxZGE1YzM2MTVhYmE5MWFjMzk3MjNiZDRjNTRlOWYzODJiM2VkMTM2OGQ1OGVjNmUiLAogICJhcHBsaWNhdGlvbkF0UHJlcGFyYXRpb24iOiAiNDIyMWQ5YzA2ZGEwNzkzMjFkNGZlMjgwMzg3OWJhODIwNDNkN2ExZiIsCiAgIndvcmtzcGFjZUhhc2giOiAiYTM4MzA3Zjc1NjIwZGU0YmZlM2IzNzRlZDJkNTEwMDQxZGE4MDdhZjA5NGM1NzFlYWZiMDMxOGNlMjFmMzUzNSIsCiAgIm5vcm1hbFNlc3Npb25WZXJpZmllZCI6IHRydWUsCiAgInNoYXJlZFRlYW1WZXJpZmllZCI6IHRydWUsCiAgImJvdElkIjogImZkZWVhNDVmLThjYjItNDUwYS05NmE0LWQ5YTY4MmY3MTQ4MiIsCiAgImJvdE5hbWUiOiAi5rWL6K+VMTUwNSA2MjBhMzY0NyIsCiAgImJvdFJldGVudGlvbiI6ICJyZXVzZWRfZXhpc3Rpbmdfbm9fZGVsZXRlX2FwaSIsCiAgImJvdE93bmVkQW5kTmFtZWQiOiB0cnVlLAogICJib3RJZGxlSGlzdG9yeSI6IHsKICAgICJpdGVtcyI6IDE4LAogICAgImN1cnNvciI6IDQ0LAogICAgInBlcnNpc3RlZFN0cmVhbXMiOiAxMiwKICAgICJwZW5kaW5nSXRlbXMiOiAwCiAgfSwKICAiYm90SWRsZU9ic2VydmVkQXQiOiAiMjAyNi0xMS0wN1QyMzoyNToyMi41MzNaIiwKICAiZmluaXNoZWRBdCI6ICIyMDI2LTExLTA3VDIzOjI1OjI0LjA1M1oiCn0K'

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

export function readOriginalBot(bytes) {
  check(hash(bytes) === ORIGINAL.receiptSha256, 'original_receipt_changed')
  const report = JSON.parse(bytes.toString('utf8'))
  check(report.version === 1 && report.issue === 1505 && report.status === 'prepared'
    && report.workflowHead === ORIGINAL.helperCommit && report.workflowRunId === ORIGINAL.runId && report.attempt === ORIGINAL.attempt
    && report.fixtureId === ORIGINAL.fixtureId && report.botId === ORIGINAL.botId && report.botName === ORIGINAL.botName
    && report.projectId === PROJECT && report.teamId === TEAM && SHA.test(report.requesterHash) && SHA.test(report.workspaceHash)
    && report.cleanup?.botStopped === true && report.cleanup.workspaceRestored === true && report.cleanup.signedOut === true
    && Array.isArray(report.cleanup.errors) && report.cleanup.errors.length === 0
    && report.modelsDispatched === 0 && report.virtualMachinesCreated === 0 && report.profilesCreated === 0, 'original_receipt_invalid')
  return { botId: report.botId, botName: report.botName, fixtureId: report.fixtureId,
    requesterHash: report.requesterHash, workspaceHash: report.workspaceHash, receiptSha256: ORIGINAL.receiptSha256 }
}

export async function prepareWindow({ env, helpers, reuse, fetchImpl = fetch, now = Date.now, save = async () => {} }) {
  const report = { version: 1, issue: 1505, sourceCommit: SOURCE, sourceTree: TREE, projectId: PROJECT, teamId: TEAM,
    workflowRunId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, workflowHead: env.GITHUB_SHA,
    helperBranch: BRANCH, fixtureId: randomUUID(), startedAt: new Date(now()).toISOString(), status: 'running',
    scope: 'dedicated_bot_repository_window', modelsDispatched: 0, virtualMachinesCreated: 0, profilesCreated: 0,
    botCreationAttempted: false, botStopAttempted: false,
    reusedFrom: { receiptSha256: ORIGINAL.receiptSha256, workflowRunId: ORIGINAL.runId, fixtureId: ORIGINAL.fixtureId },
    cleanup: { botIdleVerified: false, workspaceRestored: false, signedOut: false, errors: [] }, window: null }
  const client = helpers.createSessionClient(ORIGIN, fetchImpl)
  let stage = 'configuration_preflight', loginAttempted = false, requesterId, workspaceId, originalWorkspaceId, accountReady = false
  const call = (path, options = {}) => platform(path, { token: env.VERCEL_TEAM_TOKEN, fetchImpl, ...options })
  try {
    check(reuse?.botId === ORIGINAL.botId && reuse.botName === ORIGINAL.botName && reuse.fixtureId === ORIGINAL.fixtureId
      && reuse.receiptSha256 === ORIGINAL.receiptSha256 && SHA.test(reuse.requesterHash) && SHA.test(reuse.workspaceHash), 'original_receipt_invalid')
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
      check(report.requesterHash === reuse.requesterHash, 'reused_bot_requester_changed')
      const version = await client.json('/api/version')
      check(/^[0-9a-f]{40}$/.test(version.build ?? ''), 'application_version_invalid')
      report.applicationAtPreparation = version.build
      stage = 'normal_team_selection'
      const scope = await helpers.selectAcceptanceTeam(client, { ownerId: requesterId }, value => { originalWorkspaceId = value })
      workspaceId = scope.workspaceId
      check(UUID.test(workspaceId) && scope.adminId !== requesterId && scope.evidence?.teamAdminMembershipVerified === true, 'shared_team_not_verified')
      report.workspaceHash = hash(workspaceId)
      check(report.workspaceHash === reuse.workspaceHash, 'reused_bot_workspace_changed')
      report.normalSessionVerified = true; report.sharedTeamVerified = true
      stage = 'normal_bot_reuse'
      // The normal GET independently requires both this session owner and its current workspace.
      const bot = await client.json(`/api/bots/${reuse.botId}`)
      check(bot.id === reuse.botId && bot.name === reuse.botName, 'reused_bot_identity_changed')
      report.botId = bot.id; report.botName = bot.name; report.botRetention = 'reused_existing_no_delete_api'
      report.botOwnedAndNamed = true
      stage = 'normal_bot_idle_read'
      // This registered read does not welcome/wake the chat; a failed/busy read never stops it.
      const chat = await client.rpc('coordinator.pollCoordinatorChat', [bot.id])
      // Completed history survives stopCoordinatorTurn and task cleanup. It is
      // not current work: require no active lease, pending item or chat error.
      // Do not erase history or copy message bodies into the recovery record.
      check(chat?.botId === bot.id && chat.enabled === true && chat.working === false && chat.error === null
        && chat.streamRunId === undefined && Array.isArray(chat.items)
        && chat.items.every(item => item && typeof item === 'object' && !Array.isArray(item)
          && (item.pending === undefined || item.pending === false)
          && Number.isSafeInteger(item.position) && item.position >= 0)
        && Number.isSafeInteger(chat.cursor) && chat.cursor >= 0
        && (chat.historyBefore === undefined || (Number.isSafeInteger(chat.historyBefore) && chat.historyBefore >= 0))
        && Array.isArray(chat.persistedStreamIds) && chat.persistedStreamIds.every(id => typeof id === 'string' && id.length > 0),
        'reused_bot_not_confirmed_idle')
      report.botIdleHistory = { items: chat.items.length, cursor: chat.cursor,
        persistedStreams: chat.persistedStreamIds.length, pendingItems: 0,
        ...(chat.historyBefore === undefined ? {} : { historyBefore: chat.historyBefore }) }
      report.cleanup.botIdleVerified = true; report.botIdleObservedAt = new Date(now()).toISOString(); accountReady = true
      await save(report)
    } catch (error) { report.error = { stage, ...closedError(error) } }
    finally {
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
    check(accountReady && !report.error && report.cleanup.botIdleVerified && report.cleanup.workspaceRestored
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


/** The preceding owned receipt is immutable public recovery metadata, never a credential. */
export function readPreviousWindow(bytes = Buffer.from(PREVIOUS_RECEIPT_BASE64, 'base64')) {
  check(hash(bytes) === PREVIOUS_RECEIPT_SHA256, 'previous_receipt_changed')
  const report = JSON.parse(bytes.toString('utf8'))
  check(report.version === 1 && report.issue === 1505 && report.status === 'prepared'
    && report.sourceCommit === SOURCE && report.sourceTree === TREE
    && report.workflowHead === HELPER_PARENT && report.workflowRunId === '42425101165' && report.attempt === '1'
    && report.projectId === PROJECT && report.teamId === TEAM
    && report.botId === ORIGINAL.botId && report.botName === ORIGINAL.botName
    && report.requesterHash === 'b823ba1c5729768b1da5c3615aba91ac39723bd4c54e9f382b3ed1368d58ec6e'
    && report.workspaceHash === 'a38307f75620de4bfe3b374ed2d510041da807af094c571eafb0318ce21f3535'
    && report.window?.key === KEY && report.window.id === 'ZLpt0i7CTNlk5XFR'
    && report.window.valueSha256 === '6242c4c368f5805f6bcb3538559b5b30b851c4ee0622823f16c03bf8044814b3'
    && report.window.expiresAt === '2026-11-08T01:25:23.422Z' && report.window.durationMinutes === 120
    && report.window.readbackVerified === true && report.window.creationAcknowledged === true
    && report.cleanup?.botIdleVerified === true && report.cleanup.workspaceRestored === true && report.cleanup.signedOut === true
    && Array.isArray(report.cleanup.errors) && report.cleanup.errors.length === 0
    && report.botCreationAttempted === false && report.botStopAttempted === false
    && report.modelsDispatched === 0 && report.virtualMachinesCreated === 0 && report.profilesCreated === 0,
    'previous_receipt_invalid')
  return report
}

/** Main supplies only the pinned preceding receipt. No request retry or uncertain-write recovery is automatic. */
export async function renewWindow({ previous, env, helpers, reuse, fetchImpl = fetch, now = Date.now,
  save = async () => {}, saveRotation = async () => {} }) {
  const report = { version: 1, issue: 1505, sourceCommit: SOURCE, sourceTree: TREE,
    workflowRunId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, workflowHead: env.GITHUB_SHA,
    helperBranch: BRANCH, operation: 'replace_owned_diagnostic_window', status: 'running',
    previousReceiptSha256: PREVIOUS_RECEIPT_SHA256, previousWorkflowRunId: previous.workflowRunId,
    previousWindow: { id: previous.window.id, valueSha256: previous.window.valueSha256, expiresAt: previous.window.expiresAt },
    startedAt: new Date(now()).toISOString(), removal: null, newWindow: null,
    modelsDispatched: 0, virtualMachinesCreated: 0, profilesCreated: 0, activeDeploymentRevoked: false }
  let stage = 'persist_previous_ownership'
  const persist = async () => {
    try { await saveRotation(report) }
    catch (cause) { throw Object.assign(new Error('recovery_artifact_write_failed', { cause }), { windowCode: 'recovery_artifact_write_failed' }) }
  }
  try {
    await persist()
    stage = 'remove_previous_window'
    report.removal = await removeOwnedWindow(previous, { token: env.VERCEL_TEAM_TOKEN, fetchImpl, now })
    stage = 'persist_previous_removal'
    await persist()
    stage = 'prepare_fresh_window'
    const prepared = await prepareWindow({ env, helpers, reuse, fetchImpl, now, save })
    report.newWindow = prepared.window
    report.newFixtureId = prepared.fixtureId
    check(prepared.status === 'prepared', 'fresh_window_not_prepared')
    report.status = 'renewed'
  } catch (error) {
    report.status = 'failed'; report.error = { stage, ...closedError(error) }
    report.recovery = { preserveHelperRef: true, repeatPreparationAutomatically: false,
      previousWindowMayRemain: report.removal?.projectEnvironmentRemoved !== true,
      newWindowWriteMayExist: report.newWindow?.writeAttempted === true }
  } finally {
    report.finishedAt = new Date(now()).toISOString()
    try { await persist() }
    catch { report.status = 'failed'; report.error ??= { stage: 'save_rotation', code: 'recovery_artifact_write_failed' }
      report.recovery = { preserveHelperRef: true, repeatPreparationAutomatically: false,
        previousWindowMayRemain: report.removal?.projectEnvironmentRemoved !== true,
        newWindowWriteMayExist: report.newWindow?.writeAttempted === true } }
  }
  return report
}

async function main() {
  const [mode, output, input] = process.argv.slice(2)
  check(process.env.DIAGNOSTIC_WINDOW_GO === GO && process.env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && process.env.GITHUB_RUN_ATTEMPT === '1'
    && process.env.GITHUB_REF === `refs/heads/${mode === 'remove' ? BRANCH + '-cleanup' : BRANCH}`, 'execution_not_reviewed')
  check(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === SOURCE
    && execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim() === TREE, 'source_not_pinned')
  const opsRoot = fileURLToPath(new URL('../../', import.meta.url))
  check(execFileSync('git', ['-C', opsRoot, 'rev-list', '--parents', '-n', '1', 'HEAD'], { encoding: 'utf8' }).trim()
    === `${process.env.GITHUB_SHA} ${HELPER_PARENT}`
    && execFileSync('git', ['-C', opsRoot, 'rev-parse', `${HELPER_PARENT}^{tree}`], { encoding: 'utf8' }).trim() === HELPER_PARENT_TREE,
    'helper_parent_not_pinned')
  check(JSON.stringify(execFileSync('git', ['-C', opsRoot, 'diff', '--name-only', HELPER_PARENT, 'HEAD'], { encoding: 'utf8' }).trim().split('\n').sort())
    === JSON.stringify(['.github/workflows/issue1505-diagnostic-window.yml', 'scripts/ops/issue1505-diagnostic-window.mjs']), 'helper_files_not_pinned')
  const reuse = readOriginalBot(await readFile(new URL('./issue1505-diagnostic-window-original-42366750743.json', import.meta.url)))
  const previous = readPreviousWindow()
  check(previous.requesterHash === reuse.requesterHash && previous.workspaceHash === reuse.workspaceHash, 'previous_owner_changed')
  check(['verify', 'renew', 'remove'].includes(mode) && typeof output === 'string' && output.length > 0, 'arguments_invalid')
  const save = async data => { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(output, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }) }
  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(resolve(dirname(output), 'diagnostic-window-previous.json'), Buffer.from(PREVIOUS_RECEIPT_BASE64, 'base64'), { mode: 0o600 })
  let report
  if (mode === 'verify') {
    report = { status: 'verified', sourceCommit: SOURCE, sourceTree: TREE, originalReceiptSha256: ORIGINAL.receiptSha256,
      botId: reuse.botId, previousReceiptSha256: PREVIOUS_RECEIPT_SHA256, previousWindowId: previous.window.id, modelCalls: 0, accountCalls: 0 }
    await save(report)
  } else if (mode === 'renew') {
    check(typeof input === 'string' && input.length > 0 && resolve(input) !== resolve(output), 'rotation_record_missing')
    const saveRotation = async data => { await mkdir(dirname(resolve(input)), { recursive: true }); await writeFile(input, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }) }
    const helpers = await import(pathToFileURL(resolve('scripts/acceptance/cloud-startup.mjs')).href)
    report = await renewWindow({ previous, env: process.env, helpers, reuse, save, saveRotation })
    if (report.status !== 'renewed') process.exitCode = 1
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
