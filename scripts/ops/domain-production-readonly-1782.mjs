/** One fixed #1687 active-report verification and read-only APP/WS inspection.
 * Defaults are deliberately unbound. No models, resource creation, repairs,
 * Workspace switch, arbitrary SQL, generic payload or caller-supplied origin. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { workflowGuard } from './self-hosted-closeout.mjs'
import { checkWindow, guardWindowContext, guardWindowScope } from './domain-history-before-1782.mjs'
import { createSessionClient, smokeAcceptanceAccount } from '../acceptance/cloud-startup.mjs'
import { COUNTERS, LEDGER, REQUIRED_ZERO, SQL } from './domain-production-readonly-1782-sql.mjs'

const REPO = 'alexj11324/Mikka', BRANCH = 'ops/self-hosted-vault-closeout-20261108'
const API = 'https://api.github.com/repos/' + REPO, ORIGIN = 'https://app.aspectlylabs.com'
const PATH = '.github/workflows/issue1782-domain-production-readonly.yml'
const ACTIVE_PATH = '.github/workflows/production-smoke.yml'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/, MD5 = /^[a-f0-9]{32}$/
const MAX_ARCHIVE = 2 * 1024 * 1024, MAX_REPORT = 1024 * 1024
const positive = value => Number.isSafeInteger(value) && value > 0
const revision = value => Number.isSafeInteger(value) && value >= 0
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const exact = (row, keys) => row && typeof row === 'object' && !Array.isArray(row)
  && isDeepStrictEqual(Object.keys(row).sort(), [...keys].sort())
const sameIds = (left, right) => Array.isArray(left) && isDeepStrictEqual([...left].sort(), [...right].sort())
const ids = (value, max) => Array.isArray(value) && value.length > 0 && value.length <= max
  && value.every(id => UUID.test(id)) && new Set(value).size === value.length
const CODES = new Set(['binding_refused', 'source_refused', 'main_changed', 'build_changed', 'http_failed',
  'active_identity', 'active_artifact', 'active_archive', 'active_digest', 'active_report', 'account_refused',
  'workspace_refused', 'sample_changed', 'resource_changed', 'database_binding', 'database_readonly',
  'database_failed', 'metadata_invalid', 'migration_missing', 'active_snapshot', 'signout_failed', 'collection_failed',
  'window_unbound', 'window_changed', 'window_expired', 'window_source_changed', 'window_scope_changed'])
export const publicFailure = error => ({ code: CODES.has(error?.code) ? error.code : 'collection_failed' })

// Fill from the real successful owned active artifact after M exists. No CLI or
// env override is accepted, and the accompanying workflow remains disabled.
export const BINDING = Object.freeze({
  applicationSha: null, readerSha256: null, policyAdminSha256: null, workspaceId: null,
  activeRunId: null, activeRunAttempt: null, activeWorkflowId: null,
  activeActor: null, activeTriggeringActor: null,
  artifactId: null, artifactSizeBytes: null, archiveSha256: null, reportSha256: null,
  cases: null,
})
// Same reviewed finite-account contract as the before collector. This mode has
// its own actual window record; a later private repin cannot reuse its parent.
export const WINDOW = Object.freeze({ workspaceId: null, readerSha256: null, opsParentSha: null,
  commentId: null, commentBodySha256: null, startsAt: null, expiresAt: null })
const MODELS = Object.freeze({ claude: ['claude_code', 'claude-haiku-5-5'], codex: ['codex', 'gpt-6-luna'] })
const actors = actor => exact(actor, ['login', 'id']) &&
  (actor.login === 'alexj11324' && actor.id === 183887963 || actor.login === 'github-actions[bot]' && actor.id === 41898282)
const selectionKeys = ['projectId', 'environmentId', 'projectRevision', 'policyRevision', 'environmentRevision',
  'repositorySha256', 'baseBranchSha256', 'runtime', 'harness']
export function checkBinding(binding = BINDING) {
  check(exact(binding, Object.keys(BINDING)) && SHA.test(binding.applicationSha ?? '')
    && UUID.test(binding.workspaceId ?? '') && ['readerSha256', 'policyAdminSha256', 'archiveSha256', 'reportSha256'].every(key => DIGEST.test(binding[key] ?? ''))
    && ['activeRunId', 'activeRunAttempt', 'activeWorkflowId', 'artifactId', 'artifactSizeBytes'].every(key => positive(binding[key]))
    && binding.activeRunAttempt === 1 && binding.artifactSizeBytes <= MAX_ARCHIVE
    && actors(binding.activeActor) && actors(binding.activeTriggeringActor)
    && Array.isArray(binding.cases) && binding.cases.length === 2 && sameIds(binding.cases.map(row => row.case), ['claude', 'codex']), 'binding_refused')
  const allRuns = []
  for (const item of binding.cases) {
    check(exact(item, ['case', 'taskId', 'runIds', 'selection']) && UUID.test(item.taskId) && ids(item.runIds, 3)
      && exact(item.selection, selectionKeys), 'binding_refused')
    const s = item.selection
    check(UUID.test(s.projectId) && UUID.test(s.environmentId) && positive(s.projectRevision) && positive(s.environmentRevision)
      && revision(s.policyRevision) && DIGEST.test(s.repositorySha256) && DIGEST.test(s.baseBranchSha256)
      && ['any', 'cloud'].includes(s.runtime) && ['any', MODELS[item.case][0]].includes(s.harness), 'binding_refused')
    allRuns.push(...item.runIds)
  }
  check(new Set(binding.cases.map(row => row.taskId)).size === 2 && new Set(allRuns).size === allRuns.length && allRuns.length <= 6, 'binding_refused')
  return binding
}

export function guardContext(env, event, checkout, dirty) {
  workflowGuard(env)
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_WORKFLOW_REF === `${REPO}/${PATH}@refs/heads/${BRANCH}`
    && env.GITHUB_RUN_ATTEMPT === '1' && env.GITHUB_TRIGGERING_ACTOR === 'alexj11324'
    && env.GITHUB_JOB === 'domain_production_readonly' && SHA.test(env.GITHUB_SHA ?? '')
    && event.repository?.id === 1427517699 && event.repository?.owner?.id === 183887963
    && event.ref === env.GITHUB_REF && event.after === env.GITHUB_SHA && event.forced === false
    && event.deleted === false && checkout === env.GITHUB_SHA && !dirty, 'source_refused')
}

export function checkWindowBinding(binding = BINDING, window = WINDOW) {
  checkBinding(binding); checkWindow(window)
  check(window.workspaceId === binding.workspaceId && window.readerSha256 === binding.readerSha256, 'window_scope_changed')
  return window
}

export function windowRecord(binding = BINDING, window = WINDOW) {
  return { state: 'active', batch: 1782, mode: 'domain_production_readonly', mainSha: binding.applicationSha,
    workspaceSha256: hash(window.workspaceId), readerSha256: window.readerSha256, opsParentSha: window.opsParentSha,
    activeRunId: binding.activeRunId, artifactId: binding.artifactId, archiveSha256: binding.archiveSha256,
    startsAt: window.startsAt, expiresAt: window.expiresAt }
}

async function boundedBytes(response, max) {
  const length = response.headers.get('content-length')
  check(response.ok && response.body && (!length || /^\d+$/.test(length) && Number(length) <= max), 'http_failed')
  const reader = response.body.getReader(), chunks = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break
      size += value.length
      if (size > max) { await reader.cancel(); check(false, 'http_failed') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks)
}
const headers = token => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28', 'cache-control': 'no-store' })
async function readGithub(path, env, fetchImpl) {
  check(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0, 'source_refused')
  const response = await fetchImpl(API + path, { headers: headers(env.GITHUB_TOKEN), redirect: 'error', signal: AbortSignal.timeout(15000) })
  return JSON.parse(await boundedBytes(response, MAX_REPORT))
}
export async function guardMain(env, binding = BINDING, fetchImpl = fetch, window = WINDOW, now = Date.now, minimumRemainingMs = 0) {
  checkWindowBinding(binding, window)
  const currentTime = () => {
    const at = now()
    check(Number.isFinite(at) && Number.isFinite(minimumRemainingMs) && minimumRemainingMs >= 0
      && at >= Date.parse(window.startsAt) && at + minimumRemainingMs < Date.parse(window.expiresAt), 'window_expired')
    return at
  }
  const started = currentTime()
  const main = await readGithub('/git/ref/heads/main', env, fetchImpl)
  check(main.ref === 'refs/heads/main' && main.object?.type === 'commit' && main.object.sha === binding.applicationSha, 'main_changed')
  const response = await fetchImpl(ORIGIN + '/mikka/api/version?verify=1782-domain-readonly-' + started, { headers: { 'cache-control': 'no-store' },
    redirect: 'error', signal: AbortSignal.timeout(15000) })
  const version = JSON.parse(await boundedBytes(response, 8192))
  check(version.build === binding.applicationSha, 'build_changed')
  const issue = await readGithub('/issues/1752', env, fetchImpl)
  check(issue.number === 1752 && positive(issue.comments), 'window_changed')
  const comments = await readGithub('/issues/1752/comments?per_page=1&page=' + issue.comments, env, fetchImpl)
  const comment = comments?.[0]
  check(Array.isArray(comments) && comments.length === 1 && comment.id === window.commentId
    && comment.issue_url === API + '/issues/1752' && comment.user?.login === 'alexj11324' && comment.user.id === 183887963
    && typeof comment.body === 'string' && hash(comment.body) === window.commentBodySha256, 'window_changed')
  const marker = '<!-- mikka-1782-domain-production-readonly:v1\n', start = comment.body.indexOf(marker)
  const end = comment.body.indexOf('\n-->', start)
  check(start >= 0 && end > start && comment.body.indexOf(marker, start + marker.length) === -1, 'window_changed')
  let record
  try { record = JSON.parse(comment.body.slice(start + marker.length, end)) } catch { check(false, 'window_changed') }
  check(isDeepStrictEqual(record, windowRecord(binding, window)), 'window_changed')
  return { mainSha: binding.applicationSha, servedBuild: version.build, origin: ORIGIN, checkedAt: new Date(currentTime()).toISOString(),
    windowCommentId: window.commentId, windowExpiresAt: window.expiresAt, opsParentSha: window.opsParentSha }
}

export function assertActiveIdentity(binding, workflow, run, artifact, now = Date.now()) {
  checkBinding(binding)
  check(workflow.id === binding.activeWorkflowId && workflow.path === ACTIVE_PATH && workflow.name === 'Production smoke' && workflow.state === 'active'
    && run.id === binding.activeRunId && run.run_attempt === binding.activeRunAttempt && run.workflow_id === workflow.id
    && run.path === ACTIVE_PATH && run.name === workflow.name && run.event === 'workflow_dispatch'
    && run.head_branch === 'main' && run.head_sha === binding.applicationSha && run.status === 'completed' && run.conclusion === 'success'
    && run.repository?.full_name === REPO && run.repository.id === 1427517699 && run.repository.owner?.id === 183887963
    && run.head_repository?.id === 1427517699
    && run.actor?.login === binding.activeActor.login && run.actor.id === binding.activeActor.id
    && run.triggering_actor?.login === binding.activeTriggeringActor.login && run.triggering_actor.id === binding.activeTriggeringActor.id, 'active_identity')
  check(artifact.id === binding.artifactId && artifact.name === 'production-work-domain-' + binding.activeRunId
    && artifact.expired === false && artifact.size_in_bytes === binding.artifactSizeBytes
    && artifact.digest === 'sha256:' + binding.archiveSha256 && Date.parse(artifact.expires_at) > now
    && artifact.workflow_run?.id === binding.activeRunId && artifact.workflow_run.head_sha === binding.applicationSha
    && artifact.workflow_run.head_branch === 'main' && artifact.workflow_run.repository_id === 1427517699
    && artifact.workflow_run.head_repository_id === 1427517699, 'active_artifact')
}

/** Only the exact successful owned active report is interpreted; unknown fields
 * remain private memory. The returned scope is a small closed authorization set. */
export function validateActive(report, binding = BINDING) {
  checkBinding(binding)
  check(report?.version === 1 && report.issue === 1687 && report.mode === 'active' && report.origin === ORIGIN
    && report.applicationSha === binding.applicationSha && report.status === 'execution_observed_pending_snapshot_review'
    && report.cleanup?.sessionClosed === true && report.cleanup.workspaceRestored === true
    && Array.isArray(report.cleanup.errors) && report.cleanup.errors.length === 0
    && report.preflight?.workspaceId === binding.workspaceId && report.preflight.activeScopeVerified === true
    && report.team?.teamWorkspaceConfirmed === true && report.team.teamAdminMembershipVerified === true
    && report.team.teamWorkspaceHash === hash('team-workspace\0' + binding.workspaceId)
    && Array.isArray(report.cases) && report.cases.length === 2, 'active_report')
  const cases = []
  for (const pin of binding.cases) {
    const found = report.cases.filter(row => row.case === pin.case); check(found.length === 1, 'active_report')
    const item = found[0], s = item.selection
    check(item.harness === MODELS[pin.case][0] && item.model === MODELS[pin.case][1]
      && item.status === 'execution_observed' && item.issueId === pin.taskId && pin.runIds.includes(item.runId)
      && sameIds(item.runIds, pin.runIds) && item.submitted === true && item.dispatchSettled === true
      && item.toolObserved === true && item.repositoryObserved === true && item.reportObserved === true
      && item.cleanup?.status === 'passed' && item.cleanup.tasksRetained === true && Array.isArray(item.cleanup.errors) && item.cleanup.errors.length === 0
      && Array.isArray(item.cleanup.machines) && sameIds(item.cleanup.machines.map(row => row.runId), pin.runIds)
      && item.cleanup.machines.every(row => row.state === 'ended')
      && (!item.createdProfile || item.createdProfile.confirmed === true && item.cleanup.profileArchived === true), 'active_report')
    check(Array.isArray(item.runs) && sameIds(item.runs.map(row => row.runId), pin.runIds)
      && item.runs.every(row => row.sharedIdentityVerified === true && row.credentialType === 'subscription'
        && ['succeeded', 'completed'].includes(row.status) && Object.values(MODELS).some(([harness, model]) => row.harness === harness && row.model === model)
        && row.route === (row.harness === 'codex' ? 'codex_cli' : 'claude_code_cli')), 'active_report')
    const primary = item.runs.find(row => row.runId === item.runId)
    check(primary?.harness === MODELS[pin.case][0] && primary.model === MODELS[pin.case][1], 'active_report')
    check(s && s.projectId === pin.selection.projectId && s.environmentId === pin.selection.environmentId
      && typeof s.repositoryKey === 'string' && /^v2\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(s.repositoryKey)
      && (s.baseBranch === null || typeof s.baseBranch === 'string' && s.baseBranch.length > 0 && s.baseBranch.length <= 250)
      && hash(s.repositoryKey) === pin.selection.repositorySha256 && hash(JSON.stringify(s.baseBranch)) === pin.selection.baseBranchSha256
      && ['projectRevision', 'policyRevision', 'environmentRevision', 'runtime', 'harness'].every(key => s[key] === pin.selection[key]), 'active_report')
    cases.push({ case: pin.case, taskId: pin.taskId, runIds: [...pin.runIds].sort(), selection: {
      projectId: s.projectId, environmentId: s.environmentId, repositoryKey: s.repositoryKey, baseBranch: s.baseBranch,
      projectRevision: s.projectRevision, policyRevision: s.policyRevision, environmentRevision: s.environmentRevision,
      runtime: s.runtime, harness: s.harness } })
  }
  return { workspaceId: binding.workspaceId, taskIds: cases.map(row => row.taskId).sort(), cases }
}

export function archiveEvidence(bytes, binding = BINDING) {
  checkBinding(binding)
  check(Buffer.isBuffer(bytes) && bytes.length === binding.artifactSizeBytes && hash(bytes) === binding.archiveSha256, 'active_digest')
  const source = `import base64,io,stat,sys,zipfile\nwith zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:\n    entries=archive.infolist()\n    assert len(entries)==1 and entries[0].filename=='report.json'\n    e=entries[0]\n    assert not e.is_dir() and not (e.flag_bits & 1) and not stat.S_ISLNK(e.external_attr >> 16)\n    assert 0 < e.file_size <= ${MAX_REPORT} and e.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED)\n    data=archive.read(e)\n    assert len(data)==e.file_size\n    sys.stdout.write(base64.b64encode(data).decode('ascii'))\n`
  let raw
  try { raw = Buffer.from(execFileSync('python3', ['-c', source], { input: bytes, maxBuffer: MAX_REPORT * 2,
    timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] }).toString(), 'base64') }
  catch { check(false, 'active_archive') }
  check(hash(raw) === binding.reportSha256, 'active_digest')
  let report; try { report = JSON.parse(raw) } catch { check(false, 'active_report') }
  return validateActive(report, binding)
}

export async function readActive(env, binding = BINDING, fetchImpl = fetch) {
  checkBinding(binding)
  const metadata = async () => Promise.all([
    readGithub('/actions/workflows/production-smoke.yml', env, fetchImpl),
    readGithub('/actions/runs/' + binding.activeRunId, env, fetchImpl),
    readGithub('/actions/artifacts/' + binding.artifactId, env, fetchImpl),
  ])
  const first = await metadata(); assertActiveIdentity(binding, ...first)
  const response = await fetchImpl(API + '/actions/artifacts/' + binding.artifactId + '/zip', {
    headers: headers(env.GITHUB_TOKEN), redirect: 'manual', signal: AbortSignal.timeout(15000) })
  check(response.status === 302, 'active_artifact')
  let url; try { url = new URL(response.headers.get('location')) } catch { check(false, 'active_artifact') }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
    && (/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(url.hostname)
      || /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(url.hostname)), 'active_artifact')
  await response.body?.cancel()
  const downloaded = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(30000) })
  const scope = archiveEvidence(await boundedBytes(downloaded, MAX_ARCHIVE), binding)
  const last = await metadata(); assertActiveIdentity(binding, ...last)
  check(isDeepStrictEqual(first[2], last[2]), 'active_artifact')
  return scope
}

function assertScope(scope, binding) {
  check(scope?.workspaceId === binding.workspaceId && sameIds(scope.taskIds, binding.cases.map(row => row.taskId))
    && scope.cases?.length === 2 && scope.cases.every(item => {
      const pin = binding.cases.find(row => row.case === item.case), s = item.selection
      return pin && item.taskId === pin.taskId && sameIds(item.runIds, pin.runIds)
        && s.projectId === pin.selection.projectId && s.environmentId === pin.selection.environmentId
        && hash(s.repositoryKey) === pin.selection.repositorySha256 && hash(JSON.stringify(s.baseBranch)) === pin.selection.baseBranchSha256
        && ['projectRevision', 'policyRevision', 'environmentRevision', 'runtime', 'harness'].every(key => s[key] === pin.selection[key])
    }), 'binding_refused')
}

export async function authorize(client, email, scope, binding = BINDING) {
  checkBinding(binding); assertScope(scope, binding)
  const session = await client.json('/api/auth/get-session'), ownerId = session?.user?.id
  check(typeof ownerId === 'string' && ownerId.length > 0 && ownerId.length <= 256 && hash(ownerId) === binding.readerSha256
    && session.user.email?.trim().toLowerCase() === email.trim().toLowerCase(), 'account_refused')
  const membership = async () => {
    const value = await client.json('/api/workspace?workspace=' + scope.workspaceId)
    check(value?.currentUserId === ownerId && value.workspace?.id === scope.workspaceId && value.workspace.kind === 'team'
      && ['member', 'admin'].includes(value.role) && Array.isArray(value.choices) && Array.isArray(value.members), 'workspace_refused')
    const own = value.members.filter(row => row.userId === ownerId)
    const admins = value.members.filter(row => row.userId !== ownerId && typeof row.userId === 'string' && row.role === 'admin'
      && row.status === 'active' && hash(row.userId) === binding.policyAdminSha256
      && typeof row.email === 'string' && hash(row.email.trim().toLowerCase()) === '0049e13c050f799070a7d1a95bb843f2a0519b5e8732bf6986e2e1613b8941c3')
    check(own.length === 1 && own[0].status === 'active' && own[0].role === value.role && admins.length === 1
      && value.choices.filter(row => row.id === scope.workspaceId && row.kind === 'team').length === 1, 'workspace_refused')
  }
  await membership()
  for (const item of scope.cases) {
    const s = item.selection
    const value = await client.rpc('issues.getIssue', [item.taskId], { headers: { 'x-mikka-workspace-id': scope.workspaceId } }), issue = value?.issue
    check(issue?.id === item.taskId && issue.userId === ownerId && issue.workspaceId === scope.workspaceId
      && issue.ownershipState === 'bound' && ['personal', 'workspace'].includes(issue.scope) && issue.projectId === s.projectId, 'sample_changed')
    const resources = await client.rpc('project-resources.listProjectResources', [scope.workspaceId, s.projectId],
      { headers: { 'x-mikka-workspace-id': scope.workspaceId } })
    check(Array.isArray(resources.repositories) && Array.isArray(resources.environments) && Array.isArray(resources.environmentBindings), 'resource_changed')
    const repositories = resources.repositories.filter(row => row.repositoryKey === s.repositoryKey)
    const environments = resources.environments.filter(row => row.id === s.environmentId)
    const defaults = resources.environmentBindings.filter(row => row.isDefault)
    check(repositories.length === 1 && environments.length === 1 && defaults.length <= 1, 'resource_changed')
    const repository = repositories[0], environment = environments[0], config = environment.configuration
    check(repository.baseBranch === s.baseBranch && (repository.environmentId ?? defaults[0]?.environmentId) === s.environmentId
      && environment.workspaceId === scope.workspaceId && !environment.archivedAt
      && resources.environmentBindings.some(row => row.environmentId === s.environmentId)
      && (resources.policy?.mode === 'inherit' || resources.policy?.mode === 'restricted' && resources.policy.repositoryKeys?.includes(s.repositoryKey))
      && config && ['any', 'cloud'].includes(config.runtime) && ['any', MODELS[item.case][0]].includes(config.harness)
      && Array.isArray(config.repositoryKeys) && (!config.repositoryKeys.length || config.repositoryKeys.includes(s.repositoryKey)), 'resource_changed')
  }
  await membership()
  return { ...scope, ownerId }
}

function count(value) {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n, 'metadata_invalid')
  return value
}
export function projectMetadata(kind, rows, digest, rawCounts) {
  check(['app', 'ws'].includes(kind) && Array.isArray(rows) && rows.length <= LEDGER[kind].flat().length
    && new Set(rows.map(row => row.name)).size === rows.length && digest && MD5.test(digest.digest), 'metadata_invalid')
  const migrations = rows.map(row => {
    check(LEDGER[kind].flat().includes(row.name), 'metadata_invalid')
    const time = row.appliedAt instanceof Date ? row.appliedAt : new Date(row.appliedAt)
    check(Number.isFinite(time.getTime()), 'metadata_invalid')
    return { name: row.name, appliedAt: time.toISOString() }
  }).sort((a, b) => a.name.localeCompare(b.name))
  check(LEDGER[kind].every(pair => migrations.some(row => pair.includes(row.name))), 'migration_missing')
  check(rawCounts && MD5.test(rawCounts.unknownRepairDigest), 'metadata_invalid')
  const counts = Object.fromEntries(COUNTERS[kind].map(key => [key, count(rawCounts[key])]))
  return { migrations, ledgerCount: count(digest.count), ledgerDigest: digest.digest,
    counts, unknownRepairDigest: rawCounts.unknownRepairDigest,
    findings: REQUIRED_ZERO[kind].filter(key => counts[key] !== '0').map(key => kind + '.' + key) }
}

export function projectActive(kind, scope, raw) {
  if (kind === 'app') {
    check(Array.isArray(raw.tasks) && sameIds(raw.tasks.map(row => row.id), scope.taskIds)
      && raw.tasks.every(row => row.tenant === true && row.owner === true && row.bound === true && row.identified === true && MD5.test(row.identifierDigest)), 'database_binding')
    const cases = scope.cases.map(item => {
      const rows = raw.cases[item.case], s = item.selection
      check(Array.isArray(rows) && sameIds(rows.map(row => row.id), item.runIds)
        && rows.every(row => row.issueId === item.taskId && ['tenant', 'owner', 'ended', 'succeeded', 'structured', 'snapshotTenant', 'snapshotProject',
          'snapshotRepository', 'snapshotBranch', 'snapshotEnvironment', 'snapshotRuntime', 'snapshotHarness', 'environmentStructure'].every(key => row[key] === true)
          && ['projectRevision', 'policyRevision', 'environmentRevision'].every(key => row[key] === String(s[key]))
          && ['environmentDigest', 'projectExecutionDigest', 'frozenDigest'].every(key => MD5.test(row[key]))), 'active_snapshot')
      return { case: item.case, taskId: item.taskId, runs: rows.map(row => ({ id: row.id, issueId: row.issueId,
        projectRevision: Number(row.projectRevision), policyRevision: Number(row.policyRevision), environmentRevision: Number(row.environmentRevision),
        environmentDigest: row.environmentDigest, projectExecutionDigest: row.projectExecutionDigest, frozenDigest: row.frozenDigest,
        scopeAndStructureVerified: true })).sort((a, b) => a.id.localeCompare(b.id)) }
    })
    return { tasks: raw.tasks.map(row => ({ id: row.id, identified: true, identifierDigest: row.identifierDigest })).sort((a, b) => a.id.localeCompare(b.id)), cases }
  }
  check(kind === 'ws' && raw.membership?.count === '1' && Array.isArray(raw.links) && sameIds(raw.links.map(row => row.issueId), scope.taskIds)
    && raw.links.every(row => row.project === true && row.tenant === true), 'database_binding')
  return { cases: scope.cases.map(item => {
    const rows = raw.cases[item.case], s = item.selection
    check(Array.isArray(rows) && rows.length === 1 && rows[0].id === s.projectId, 'active_snapshot')
    const row = rows[0]
    check(['tenant', 'active', 'branch', 'environment', 'linked', 'environmentActive', 'policyAllowed', 'environmentStructure'].every(key => row[key] === true)
      && positive(row.projectRevision) && positive(row.environmentRevision) && revision(row.policyRevision)
      && ['projectRevision', 'policyRevision', 'environmentRevision'].every(key => row[key] >= s[key])
      && MD5.test(row.environmentDigest), 'active_snapshot')
    return { case: item.case, projectId: s.projectId, environmentId: s.environmentId, projectRevision: row.projectRevision,
      policyRevision: row.policyRevision, environmentRevision: row.environmentRevision, environmentDigest: row.environmentDigest,
      scopeAndStructureVerified: true, revisionDrift: ['projectRevision', 'policyRevision', 'environmentRevision'].filter(key => row[key] !== s[key]) }
  }) }
}

export async function readDatabase(kind, db, scope, binding = BINDING, observe = () => {}) {
  checkBinding(binding); assertScope(scope, binding)
  check(['app', 'ws'].includes(kind) && typeof scope.ownerId === 'string' && hash(scope.ownerId) === binding.readerSha256, 'database_binding')
  let begun = false
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true
    await db.query("SET LOCAL statement_timeout = '20s'"); await db.query("SET LOCAL lock_timeout = '2s'")
    await db.query("SET LOCAL idle_in_transaction_session_timeout = '30s'")
    const settings = (await db.query(SQL.settings)).rows[0]
    check(settings?.readonly === 'on' && settings.isolation === 'repeatable read', 'database_readonly')
    observe({ readOnly: true, isolation: 'repeatable read' })
    const metadata = projectMetadata(kind, (await db.query(SQL.ledger, [LEDGER[kind].flat()])).rows,
      (await db.query(SQL.ledgerDigest)).rows[0], (await db.query(SQL[kind + 'Counts'])).rows[0])
    observe({ metadata })
    const raw = { cases: {} }
    if (kind === 'app') raw.tasks = (await db.query(SQL.appTasks, [scope.taskIds, scope.workspaceId, scope.ownerId])).rows
    else {
      raw.membership = (await db.query(SQL.wsMembership, [scope.workspaceId, scope.ownerId])).rows[0]
      raw.links = []
      for (const item of scope.cases) raw.links.push(...(await db.query(SQL.wsLinks, [[item.taskId], item.selection.projectId, scope.workspaceId])).rows)
    }
    for (const item of scope.cases) {
      const s = item.selection
      raw.cases[item.case] = kind === 'app'
        ? (await db.query(SQL.appRuns, [item.runIds, scope.workspaceId, scope.ownerId, s.projectId, s.repositoryKey, s.baseBranch, s.environmentId, s.runtime, s.harness])).rows
        : (await db.query(SQL.wsResource, [s.projectId, scope.workspaceId, s.environmentId, s.baseBranch, s.repositoryKey])).rows
    }
    return { metadata, active: projectActive(kind, scope, raw), readOnly: true, isolation: 'repeatable read' }
  } finally { if (begun) { await db.query('ROLLBACK'); observe({ transactionRolledBack: true }) } }
}

export function compareDatabases(app, ws) {
  const findings = [...app.metadata.findings, ...ws.metadata.findings]
  const cases = app.active.cases.map(item => {
    const resources = ws.active.cases.find(row => row.case === item.case)
    check(resources, 'active_snapshot')
    for (const row of item.runs) if (resources.environmentRevision === row.environmentRevision)
      check(resources.environmentDigest === row.environmentDigest, 'active_snapshot')
    if (resources.revisionDrift.length) findings.push('active.' + item.case + '.revision_drift')
    return { case: item.case, taskId: item.taskId, runIds: item.runs.map(row => row.id),
      projectId: resources.projectId, environmentId: resources.environmentId,
      frozenSelectionsVerified: true, environmentDigestComparedAtSameRevision: !resources.revisionDrift.includes('environmentRevision'),
      currentRevisionDrift: resources.revisionDrift }
  })
  return { cases, findings, status: findings.length ? 'collected_with_findings' : 'metadata_and_active_snapshot_verified' }
}

export async function closeResources(pools, client, signedIn, cleanup) {
  let failed = false
  for (const kind of ['app', 'ws']) {
    cleanup[kind].connectionClosed = false
    try { if (pools[kind]) await pools[kind].end(); cleanup[kind].connectionClosed = true }
    catch { failed = true }
  }
  cleanup.signedOut = false
  if (signedIn) {
    try { const result = await client.request('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      check(result.ok, 'signout_failed'); cleanup.signedOut = true }
    catch { failed = true }
  }
  cleanup.sessionCleared = false
  try { client.clear(); cleanup.sessionCleared = true } catch { failed = true }
  return !failed
}

async function main(operation) {
  check(['check', 'capture'].includes(operation), 'source_refused')
  const env = process.env, binding = checkBinding()
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16384 }).trim()
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
  guardContext(env, event, git('rev-parse', 'HEAD'), git('status', '--porcelain', '--untracked-files=all') !== '')
  guardWindowContext(event, git('show', '-s', '--format=%P', 'HEAD').split(' '), WINDOW)
  const minimumRemainingMs = operation === 'check' ? 4 * 60000 : 3 * 60000
  const before = await guardMain(env, binding, fetch, WINDOW, Date.now, minimumRemainingMs), active = await readActive(env, binding)
  // Artifact reads are bounded but may consume time. Recheck the actual grant
  // before returning permission to read credentials or start a normal session.
  await guardMain(env, binding, fetch, WINDOW, Date.now, minimumRemainingMs)
  if (operation === 'check') { console.log(JSON.stringify({ sourceVerified: true, applicationSha: binding.applicationSha,
    activeRunId: binding.activeRunId, artifactId: binding.artifactId, cases: 2, runs: binding.cases.reduce((n, item) => n + item.runIds.length, 0) })); return }
  const { email, password } = smokeAcceptanceAccount(env)
  const credentials = { app: env.MIKKA_DATABASE_URL, ws: env.DATABASE_URL }, targets = {}
  for (const kind of ['app', 'ws']) {
    check(typeof credentials[kind] === 'string' && credentials[kind].length > 0, 'database_binding')
    const target = new URL(credentials[kind])
    check(['postgres:', 'postgresql:'].includes(target.protocol) && target.hostname && target.pathname, 'database_binding')
    targets[kind] = hash(kind + '-db-target\0' + target.hostname + '\0' + target.pathname)
  }
  const { Pool } = createRequire(resolve(env.DOMAIN_READONLY_DEPENDENCIES, 'package.json'))('pg')
  let cleaning = false, signedIn = false
  const deadline = AbortSignal.timeout(100000)
  const client = createSessionClient(ORIGIN, (url, init) => fetch(url, { ...init,
    signal: cleaning ? AbortSignal.timeout(10000) : AbortSignal.any([deadline, init.signal, AbortSignal.timeout(10000)]) }))
  const pools = {}, report = { version: 1, issue: 1687, batch: 1782, phase: 'metadata_and_active_snapshot', status: 'incomplete',
    opsSource: env.GITHUB_SHA, applicationSha: binding.applicationSha, runId: env.GITHUB_RUN_ID, runAttempt: 1,
    sourceSha256: hash(await readFile(new URL(import.meta.url))), sqlSha256: hash(await readFile(new URL('./domain-production-readonly-1782-sql.mjs', import.meta.url))),
    before, startedAt: new Date().toISOString(), databaseTargetSha256: targets,
    readerSha256: binding.readerSha256, policyAdminSha256: binding.policyAdminSha256, workspaceId: binding.workspaceId,
    activeEvidence: { runId: binding.activeRunId, attempt: binding.activeRunAttempt, workflowId: binding.activeWorkflowId,
      artifactId: binding.artifactId, archiveSha256: binding.archiveSha256, reportSha256: binding.reportSha256 },
    databaseEvidence: { app: {}, ws: {} }, snapshots: {},
    cleanup: { app: { transactionRolledBack: false, connectionClosed: false }, ws: { transactionRolledBack: false, connectionClosed: false },
      signedOut: false, sessionCleared: false },
    limitations: ['separate_database_snapshots_not_cross_database_atomic', 'normal_api_read_maintenance_writes_not_measured',
      'ledger_names_not_sql_byte_attestation', 'environment_setup_not_exercised', 'active_sample_not_historical_before_after_comparison',
      'api_database_entity_match_not_vercel_environment_inspection'] }
  try {
    const login = await client.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, rememberMe: false }) })
    signedIn = true; check(login.ok, 'account_refused')
    const scope = await authorize(client, email, active, binding)
    guardWindowScope(scope, WINDOW)
    await guardMain(env, binding)
    for (const kind of ['app', 'ws']) {
      const pool = pools[kind] = new Pool({ connectionString: credentials[kind], max: 1, connectionTimeoutMillis: 15000,
        query_timeout: 25000, application_name: 'mikka-1782-domain-readonly-' + kind, options: '-c default_transaction_read_only=on' })
      pool.on('error', () => { report.connectionError = true })
      const db = await pool.connect()
      try { report.snapshots[kind] = await readDatabase(kind, db, scope, binding, value => {
        report.databaseEvidence[kind] = { ...report.databaseEvidence[kind], ...value }
        if (value.transactionRolledBack === true) report.cleanup[kind].transactionRolledBack = true
      }) } finally { db.release() }
    }
    guardWindowScope(await authorize(client, email, active, binding), WINDOW)
    report.after = await guardMain(env, binding)
    check(!report.connectionError, 'database_failed')
    report.comparison = compareDatabases(report.snapshots.app, report.snapshots.ws)
    report.status = report.comparison.status
  } catch (error) { report.failure = publicFailure(error); report.status = 'failed' }
  finally {
    cleaning = true
    if (!await closeResources(pools, client, signedIn, report.cleanup)) report.status = 'failed'
    if (report.status === 'metadata_and_active_snapshot_verified' && !(['app', 'ws'].every(kind => report.cleanup[kind].transactionRolledBack
      && report.cleanup[kind].connectionClosed) && report.cleanup.signedOut && report.cleanup.sessionCleared)) {
      report.status = 'failed'; report.failure = { code: 'database_failed' }
    }
    report.completedAt = new Date().toISOString()
    const output = resolve(env.RUNNER_TEMP, 'domain-production-readonly-1782')
    await mkdir(output, { recursive: true, mode: 0o700 })
    const bytes = JSON.stringify(report, null, 2) + '\n'
    await writeFile(resolve(output, 'report.json'), bytes, { mode: 0o600 })
    const receipt = { phase: report.phase, status: report.status, opsSource: env.GITHUB_SHA, applicationSha: binding.applicationSha,
      runId: env.GITHUB_RUN_ID, runAttempt: 1, activeRunId: binding.activeRunId, evidenceSha256: hash(bytes),
      cleanup: report.cleanup, ...(report.failure ? { failure: report.failure } : {}) }
    await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify(receipt))
  }
  if (report.status !== 'metadata_and_active_snapshot_verified') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(JSON.stringify(publicFailure(error))); process.exitCode = 1 })
}
