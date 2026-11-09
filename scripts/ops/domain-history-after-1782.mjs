/** #1782, one read-only comparison against the independently verified before
 * artifact. No reselection of Tasks, model execution or business writes. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { workflowGuard } from './self-hosted-closeout.mjs'
import { EPIC_MIGRATIONS, SQL as BEFORE_SQL, projectRows, readHistoryTaskAccess,
  verifyDatabaseTaskAccess, verifyScope } from './domain-history-before-1782.mjs'
import { createSessionClient, smokeAcceptanceAccount } from '../acceptance/cloud-startup.mjs'

const REPO = 'alexj11324/Mikka', BRANCH = 'ops/self-hosted-vault-closeout-20261108'
const API = 'https://api.github.com/repos/' + REPO, ORIGIN = 'https://app.aspectlylabs.com'
const BEFORE_PATH = '.github/workflows/issue1782-domain-history-before.yml'
const AFTER_PATH = '.github/workflows/issue1782-domain-history-after.yml'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{40}$/, DIGEST = /^[0-9a-f]{64}$/, MD5 = /^[0-9a-f]{32}$/
const MAX_ARCHIVE = 2 * 1024 * 1024, MAX_REPORT = 1024 * 1024
const positive = value => Number.isSafeInteger(value) && value > 0
const hash = value => createHash('sha256').update(value).digest('hex')
const emptyIdentifier = hash(JSON.stringify(''))
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const CODES = new Set(['binding_refused', 'source_refused', 'main_changed', 'build_changed', 'http_failed',
  'before_identity', 'before_artifact', 'before_archive', 'before_digest', 'before_projection',
  'account_refused', 'workspace_refused', 'sample_changed', 'sample_invalid', 'database_binding',
  'database_readonly', 'database_failed', 'migration_missing', 'history_missing', 'history_changed',
  'identifier_missing', 'identifier_alias', 'publication_alias', 'signout_failed', 'after_failed'])
export const publicFailure = error => ({ code: CODES.has(error?.code) ? error.code : 'after_failed' })

// Fill only after M exists and a real captured_before artifact has been
// independently SHA/CRC/source/cleanup checked. No CLI or env overrides.
export const BINDING = Object.freeze({
  applicationSha: null,
  beforeMainSha: null,
  beforeOpsSource: null, beforeCollectorSha256: null,
  beforeRunId: null, beforeRunAttempt: null, beforeWorkflowId: null,
  artifactId: null, artifactSizeBytes: null, archiveSha256: null,
  beforeSha256: null, receiptSha256: null,
  taskIds: null, publicationIds: null, runIds: null,
  workspaceId: null, workspaceKind: null, readerSha256: null, policyAdminSha256: null, taskCreatorSha256: null,
})

const ids = (value, max) => Array.isArray(value) && value.length > 0 && value.length <= max
  && value.every(id => UUID.test(id)) && new Set(value).size === value.length
  && isDeepStrictEqual(value, [...value].sort())
export function checkBinding(binding = BINDING) {
  check(SHA.test(binding.applicationSha ?? '') && SHA.test(binding.beforeMainSha ?? '')
    && binding.applicationSha !== binding.beforeMainSha && SHA.test(binding.beforeOpsSource ?? '')
    && ['beforeCollectorSha256', 'archiveSha256', 'beforeSha256', 'receiptSha256'].every(key => DIGEST.test(binding[key] ?? ''))
    && ['beforeRunId', 'beforeRunAttempt', 'beforeWorkflowId', 'artifactId', 'artifactSizeBytes'].every(key => positive(binding[key]))
    && binding.beforeRunAttempt === 1 && binding.artifactSizeBytes <= MAX_ARCHIVE
    && ids(binding.taskIds, 10) && ids(binding.publicationIds, 1000) && ids(binding.runIds, 1000)
    && UUID.test(binding.workspaceId ?? '') && binding.workspaceKind === 'team'
    && DIGEST.test(binding.readerSha256 ?? '') && DIGEST.test(binding.policyAdminSha256 ?? '')
    && closed(binding.taskCreatorSha256, binding.taskIds)
    && binding.taskIds.every(id => DIGEST.test(binding.taskCreatorSha256[id])), 'binding_refused')
  return binding
}

export function guardContext(env, event, checkout, dirty) {
  workflowGuard(env)
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_WORKFLOW_REF === `${REPO}/${AFTER_PATH}@refs/heads/${BRANCH}`
    && env.GITHUB_RUN_ATTEMPT === '1' && env.GITHUB_TRIGGERING_ACTOR === 'alexj11324'
    && env.GITHUB_JOB === 'domain_history_after' && event.repository?.id === 1427517699
    && event.repository?.owner?.id === 183887963 && event.ref === env.GITHUB_REF && event.after === env.GITHUB_SHA
    && event.forced === false && event.deleted === false && checkout === env.GITHUB_SHA && !dirty, 'source_refused')
}

async function boundedBytes(response, max) {
  const length = response.headers.get('content-length')
  check(response.ok && response.body && (!length || /^\d+$/.test(length) && Number(length) <= max), 'http_failed')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
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

export async function guardMain(env, binding = BINDING, fetchImpl = fetch) {
  checkBinding(binding)
  const main = await readGithub('/git/ref/heads/main', env, fetchImpl)
  check(main.ref === 'refs/heads/main' && main.object?.type === 'commit' && main.object.sha === binding.applicationSha, 'main_changed')
  const response = await fetchImpl(ORIGIN + '/mikka/api/version', { headers: { 'cache-control': 'no-store' },
    redirect: 'error', signal: AbortSignal.timeout(15000) })
  const version = JSON.parse(await boundedBytes(response, 8192))
  check(version.build === binding.applicationSha, 'build_changed')
  return { mainSha: binding.applicationSha, servedBuild: version.build, origin: ORIGIN, checkedAt: new Date().toISOString() }
}

/** GitHub metadata is independently read by ID; no URL comes from the report. */
export function assertBeforeIdentity(binding, workflow, run, artifact, now = Date.now()) {
  checkBinding(binding)
  check(workflow.id === binding.beforeWorkflowId && workflow.path === BEFORE_PATH
    && workflow.name === 'Issue 1782 read-only domain history before' && workflow.state === 'active'
    && run.id === binding.beforeRunId && run.run_attempt === binding.beforeRunAttempt && run.workflow_id === workflow.id
    && run.path === BEFORE_PATH && run.name === workflow.name && run.event === 'push' && run.head_branch === BRANCH
    && run.head_sha === binding.beforeOpsSource && run.status === 'completed' && run.conclusion === 'success'
    && run.repository?.full_name === REPO && run.repository?.id === 1427517699
    && run.head_repository?.full_name === REPO && run.head_repository?.id === 1427517699
    && run.actor?.login === 'alexj11324' && run.actor?.id === 183887963
    && run.triggering_actor?.login === 'alexj11324' && run.triggering_actor?.id === 183887963, 'before_identity')
  check(artifact.id === binding.artifactId && artifact.name === `domain-history-before-1782-${binding.beforeRunId}-${binding.beforeRunAttempt}`
    && artifact.digest === 'sha256:' + binding.archiveSha256 && artifact.size_in_bytes === binding.artifactSizeBytes
    && artifact.expired === false && Date.parse(artifact.created_at) >= Date.parse(run.created_at)
    && Date.parse(artifact.created_at) <= Date.parse(run.updated_at) && Date.parse(artifact.expires_at) > now
    && artifact.workflow_run?.id === binding.beforeRunId && artifact.workflow_run.head_sha === binding.beforeOpsSource
    && artifact.workflow_run.head_branch === BRANCH && artifact.workflow_run.repository_id === 1427517699
    && artifact.workflow_run.head_repository_id === 1427517699, 'before_artifact')
}

/** Two exact bounded JSON members, CRC checked by zipfile, never paths on disk. */
export function archiveEvidence(bytes, binding = BINDING) {
  checkBinding(binding)
  check(Buffer.isBuffer(bytes) && bytes.length === binding.artifactSizeBytes && hash(bytes) === binding.archiveSha256, 'before_digest')
  const source = `import base64,io,json,stat,sys,zipfile\nwith zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:\n    entries=archive.infolist()\n    assert len(entries)==2 and {e.filename for e in entries}=={'before.json','receipt.json'}\n    out={}\n    for e in entries:\n        assert not e.is_dir() and not (e.flag_bits & 1) and not stat.S_ISLNK(e.external_attr >> 16)\n        assert 0 < e.file_size <= ${MAX_REPORT} and e.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED)\n        data=archive.read(e)\n        assert len(data)==e.file_size\n        out[e.filename]=base64.b64encode(data).decode('ascii')\n    sys.stdout.write(json.dumps(out))\n`
  let payload
  try { payload = JSON.parse(execFileSync('python3', ['-c', source], { input: bytes, maxBuffer: MAX_REPORT * 3,
    timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] })) }
  catch { check(false, 'before_archive') }
  const beforeBytes = Buffer.from(payload['before.json'], 'base64'), receiptBytes = Buffer.from(payload['receipt.json'], 'base64')
  check(hash(beforeBytes) === binding.beforeSha256 && hash(receiptBytes) === binding.receiptSha256, 'before_digest')
  let before, receipt
  try { before = JSON.parse(beforeBytes); receipt = JSON.parse(receiptBytes) } catch { check(false, 'before_projection') }
  return validateBefore(before, receipt, binding)
}

function closed(row, keys) { return row && typeof row === 'object' && !Array.isArray(row) && isDeepStrictEqual(Object.keys(row).sort(), [...keys].sort()) }
export function validateBefore(before, receipt, binding = BINDING) {
  checkBinding(binding)
  const cleaned = value => value?.databaseConnectionClosed === true && value.transactionRolledBack === true && value.signedOut === true
  const source = value => value?.phase === 'before' && value.status === 'captured_before'
    && value.opsSource === binding.beforeOpsSource && value.mainSha === binding.beforeMainSha
    && value.runId === String(binding.beforeRunId) && value.runAttempt === binding.beforeRunAttempt && cleaned(value.cleanup)
  check(source(before) && source(receipt) && before.version === 2 && before.issue === 1687 && before.batch === 1782
    && before.sourceSha256 === binding.beforeCollectorSha256 && receipt.evidenceSha256 === binding.beforeSha256
    && ['before', 'after'].every(key => before[key]?.mainSha === binding.beforeMainSha
      && before[key].servedBuild === binding.beforeMainSha && before[key].origin === ORIGIN)
    && before.workspaceId === binding.workspaceId && before.workspaceKind === 'team'
    && before.readerSha256 === binding.readerSha256 && before.policyAdminSha256 === binding.policyAdminSha256
    && before.scope === 'at_most_ten_existing_shared_tasks_authorized_by_normal_api'
    && before.selectionBasis === 'normal_api_policy_admin_workspace_own_thread_refs_and_per_task_detail_acl'
    && before.apiAuthorization?.mode === 'shared_workspace_live_or_owner_deleted_detail_acl'
    && before.apiAuthorization.allPassed === true && before.databaseEvidence?.normalApiAccessRechecked === true
    && before.databaseEvidence?.canonicalEpicMigrations === 0 && before.databaseEvidence.legacyEpicMigrations === 0
    && DIGEST.test(before.databaseTargetSha256)
    && before.snapshot?.readOnly === true && before.snapshot.isolation === 'repeatable read'
    && MD5.test(before.snapshot.ledgerDigest) && isDeepStrictEqual(before.taskIds, binding.taskIds)
    && isDeepStrictEqual(before.snapshot.taskIds, binding.taskIds), 'before_projection')
  const rows = before.snapshot.rows
  check(rows && isDeepStrictEqual(Object.keys(rows).sort(), ['publication', 'run', 'task']), 'before_projection')
  for (const [kind, pin] of [['task', 'taskIds'], ['publication', 'publicationIds'], ['run', 'runIds']]) {
    check(Array.isArray(rows[kind]) && isDeepStrictEqual(rows[kind].map(row => row.id), binding[pin])
      && receipt.counts?.[kind] === rows[kind].length, 'before_projection')
  }
  check(rows.task.every(row => closed(row, ['id', 'workspaceId', 'creatorSha256', 'accessMode', 'deletedAtSha256', 'issuedIdentifierPresent', 'issuedIdentifierSha256'])
    && row.workspaceId === before.workspaceId && typeof row.issuedIdentifierPresent === 'boolean'
    && row.creatorSha256 === binding.taskCreatorSha256[row.id]
    && (row.accessMode === 'live' ? row.deletedAtSha256 === null
      : row.accessMode === 'owned_deleted' && DIGEST.test(row.deletedAtSha256 ?? '') && row.creatorSha256 === before.readerSha256)
    && DIGEST.test(row.issuedIdentifierSha256) && (row.issuedIdentifierPresent ? row.issuedIdentifierSha256 !== emptyIdentifier : row.issuedIdentifierSha256 === emptyIdentifier)), 'before_projection')
  check(rows.publication.every(row => closed(row, ['id', 'issueId', 'identifierSha256', 'branchSha256', 'baseBranchSha256', 'remoteKeySha256'])
    && binding.taskIds.includes(row.issueId) && ['identifierSha256', 'branchSha256', 'baseBranchSha256', 'remoteKeySha256'].every(key => DIGEST.test(row[key]))), 'before_projection')
  check(rows.run.every(row => closed(row, ['id', 'issueId', 'hasProjectSnapshot', 'frozenDigest']) && binding.taskIds.includes(row.issueId)
    && typeof row.hasProjectSnapshot === 'boolean' && MD5.test(row.frozenDigest)), 'before_projection')
  check(rows.publication.length > 0 && rows.run.length > 0
    && binding.taskIds.every(id => rows.publication.some(row => row.issueId === id)
      || rows.run.some(row => row.issueId === id)), 'before_projection')
  const coverage = before.databaseEvidence.selectedCoverage
  check(before.databaseEvidence.historySelectionPolicy === 'collection_published_and_ended_with_coverage_anchors'
    && closed(coverage, ['tasks', 'publishedTasks', 'endedTasks', 'projectSnapshotRuns'])
    && coverage.tasks === rows.task.length
    && coverage.publishedTasks === new Set(rows.publication.map(row => row.issueId)).size
    && coverage.endedTasks === new Set(rows.run.map(row => row.issueId)).size
    && coverage.projectSnapshotRuns === rows.run.filter(row => row.hasProjectSnapshot).length, 'before_projection')
  return before
}

export async function readBefore(env, binding = BINDING, fetchImpl = fetch) {
  checkBinding(binding)
  const metadata = async () => Promise.all([
    readGithub('/actions/workflows/issue1782-domain-history-before.yml', env, fetchImpl),
    readGithub('/actions/runs/' + binding.beforeRunId, env, fetchImpl),
    readGithub('/actions/artifacts/' + binding.artifactId, env, fetchImpl),
  ])
  const first = await metadata(); assertBeforeIdentity(binding, ...first)
  const redirect = await fetchImpl(API + '/actions/artifacts/' + binding.artifactId + '/zip', {
    headers: headers(env.GITHUB_TOKEN), redirect: 'manual', signal: AbortSignal.timeout(15000) })
  check(redirect.status === 302, 'before_artifact')
  let url
  try { url = new URL(redirect.headers.get('location')) } catch { check(false, 'before_artifact') }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
    && (/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(url.hostname)
      || /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(url.hostname)), 'before_artifact')
  await redirect.body?.cancel()
  // Never forward GitHub or account credentials to signed artifact storage.
  const response = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(30000) })
  const before = archiveEvidence(await boundedBytes(response, MAX_ARCHIVE), binding)
  const last = await metadata(); assertBeforeIdentity(binding, ...last)
  check(isDeepStrictEqual(first[2], last[2]), 'before_artifact')
  return before
}

// Only these fixed argument positions construct the two closed query forms.
// LEFT JOIN preserves a frozen history ID even when its current binding is bad.
const authorizedTasks = (task, creator, workspace) => `WITH authorized AS (
    SELECT * FROM unnest($${task}::uuid[], $${creator}::text[]) AS a(id, creator)
  ), tasks AS (
    SELECT i.* FROM issues i JOIN authorized a ON a.id=i.id AND a.creator=i."userId"
    WHERE i."workspaceId"=$${workspace}::uuid AND i."ownershipState"='bound' AND i.scope IN ('workspace','personal')
  )`
const TASKS = authorizedTasks(1, 2, 3), HISTORY_TASKS = authorizedTasks(2, 3, 4)
export const SQL = Object.freeze({
  settings: BEFORE_SQL.settings,
  task: BEFORE_SQL.task,
  taskAccess: BEFORE_SQL.taskAccess,
  // Exact old IDs, with no current status or validity predicate in WHERE.
  publication: `${HISTORY_TASKS} SELECT p."runId" AS id, p."issueId" AS "issueId", p.identifier, p.branch,
    p."baseBranch" AS "baseBranch", p."remoteKey" AS "remoteKey",
    coalesce(i.id IS NOT NULL AND r."issueId"=p."issueId" AND r."userId"=p."userId"
      AND r."workspaceId"=i."workspaceId",false) AS "bindingValid"
    FROM run_publications p LEFT JOIN tasks i ON i.id=p."issueId" LEFT JOIN agent_runs r ON r.id=p."runId"
    WHERE p."runId"=ANY($1::uuid[]) ORDER BY p."runId"`,
  run: `${HISTORY_TASKS} SELECT r.id, r."issueId" AS "issueId", r."agentDefinition"->'projectExecution' IS NOT NULL AS "hasProjectSnapshot",
    md5(jsonb_build_object('agentDefinition',r."agentDefinition",'baseBranch',r."baseBranch")::text) AS "frozenDigest",
    coalesce(i.id IS NOT NULL AND r."workspaceId"=i."workspaceId",false) AS "bindingValid"
    FROM agent_runs r LEFT JOIN tasks i ON i.id=r."issueId"
    WHERE r.id=ANY($1::uuid[]) ORDER BY r.id`,
  ledger: BEFORE_SQL.ledger,
  taskAliases: `${TASKS} SELECT i.id, i."ownershipState"='bound' AS bound,
    EXISTS (SELECT 1 FROM task_identifier_aliases a WHERE a."issueId"=i.id AND a."ownerId"=i."userId"
      AND a."workspaceId"=i."workspaceId" AND a.identifier=i."issuedIdentifier" AND a.kind='issued') AS valid
    FROM tasks i ORDER BY i.id`,
  publicationAliases: `${HISTORY_TASKS} SELECT p."runId" AS id,
    coalesce(p.identifier IS NOT NULL AND p.identifier<>'' AND i."ownershipState"='bound'
      AND r.id IS NOT NULL AND r."workspaceId"=i."workspaceId",false) AS applicable,
    EXISTS (SELECT 1 FROM task_identifier_aliases a WHERE a."issueId"=i.id AND a."ownerId"=i."userId"
      AND a."workspaceId"=i."workspaceId" AND a.identifier=p.identifier AND a.kind='publication') AS valid
    FROM run_publications p LEFT JOIN tasks i ON i.id=p."issueId"
    LEFT JOIN agent_runs r ON r.id=p."runId" AND r."issueId"=p."issueId" AND r."userId"=p."userId"
    WHERE p."runId"=ANY($1::uuid[]) ORDER BY p."runId"`,
  added: `${TASKS} SELECT
    (SELECT count(*)::int FROM run_publications p JOIN tasks i ON i.id=p."issueId"
      JOIN agent_runs r ON r.id=p."runId" AND r."issueId"=p."issueId" AND r."userId"=p."userId" AND r."workspaceId"=i."workspaceId"
      WHERE p.status='published' AND NOT (p."runId"=ANY($4::uuid[]))) AS publications,
    (SELECT count(*)::int FROM agent_runs r JOIN tasks i ON i.id=r."issueId" AND r."workspaceId"=i."workspaceId"
      WHERE r.status IN ('succeeded','stopped','failed','cancelled') AND NOT (r.id=ANY($5::uuid[]))) AS runs`,
})

export function compareHistory(before, rows, aliases) {
  const old = before.snapshot.rows
  for (const kind of ['task', 'publication', 'run']) {
    check(rows[kind].length === old[kind].length && isDeepStrictEqual(rows[kind].map(row => row.id), old[kind].map(row => row.id)), 'history_missing')
    for (let index = 0; index < old[kind].length; index++) {
      const prior = old[kind][index], next = rows[kind][index]
      if (kind === 'task') {
        check(next.workspaceId === prior.workspaceId && next.creatorSha256 === prior.creatorSha256, 'history_changed')
        check(next.issuedIdentifierPresent === true, 'identifier_missing')
        if (prior.issuedIdentifierPresent) check(next.issuedIdentifierSha256 === prior.issuedIdentifierSha256, 'history_changed')
      } else check(isDeepStrictEqual(prior, next), 'history_changed')
    }
  }
  check(isDeepStrictEqual(aliases.task.map(row => row.id), old.task.map(row => row.id))
    && aliases.task.every(row => row.bound === true && row.valid === true), 'identifier_alias')
  check(isDeepStrictEqual(aliases.publication.map(row => row.id), old.publication.map(row => row.id))
    && aliases.publication.every(row => typeof row.applicable === 'boolean' && typeof row.valid === 'boolean'
      && (!row.applicable || row.valid)), 'publication_alias')
  return { preserved: Object.fromEntries(Object.entries(old).map(([kind, values]) => [kind, values.length])),
    existingIdentifiersPreserved: old.task.filter(row => row.issuedIdentifierPresent).length,
    firstIdentifiersVerified: old.task.filter(row => !row.issuedIdentifierPresent).length,
    trustedPublicationAliasesVerified: aliases.publication.filter(row => row.applicable).length,
    publicationAliasesNotApplicable: aliases.publication.filter(row => !row.applicable).length,
    historicalProjectSnapshots: old.run.filter(row => row.hasProjectSnapshot).length,
    historicalProjectSnapshotCoverage: old.run.some(row => row.hasProjectSnapshot)
      ? 'present_fields_preserved' : 'not_applicable_none_before' }
}

export async function snapshotAfter(db, scope, before, binding = BINDING, observe = () => {}) {
  checkBinding(binding)
  check(scope.ownerId && hash(scope.ownerId) === binding.readerSha256 && before.readerSha256 === binding.readerSha256
    && before.policyAdminSha256 === binding.policyAdminSha256 && hash(scope.adminId ?? '') === binding.policyAdminSha256
    && before.version === 2 && scope.workspaceKind === 'team' && scope.workspaceId === before.workspaceId
    && scope.workspaceId === binding.workspaceId && isDeepStrictEqual(scope.taskIds, binding.taskIds)
    && scope.taskOwners && scope.taskAccess && binding.taskIds.every(id => typeof scope.taskOwners[id] === 'string'
      && hash(scope.taskOwners[id]) === binding.taskCreatorSha256[id]), 'database_binding')
  const pairs = [binding.taskIds, binding.taskIds.map(id => scope.taskOwners[id]), scope.workspaceId]
  let begun = false
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true
    await db.query("SET LOCAL statement_timeout = '20s'")
    await db.query("SET LOCAL lock_timeout = '2s'")
    await db.query("SET LOCAL idle_in_transaction_session_timeout = '30s'")
    const settings = (await db.query(SQL.settings)).rows[0]
    observe({ readOnly: settings?.readonly === 'on', isolation: settings?.isolation === 'repeatable read' ? 'repeatable read' : 'other' })
    check(settings?.readonly === 'on' && settings.isolation === 'repeatable read', 'database_readonly')
    const ledger = (await db.query(SQL.ledger)).rows[0]
    check(ledger?.epic === EPIC_MIGRATIONS.canonical.length && ledger.legacy === 0 && MD5.test(ledger.digest), 'migration_missing')
    observe(await verifyDatabaseTaskAccess(db, scope, binding.taskIds))
    const raw = {}
    for (const [kind, pin] of [['task', 'taskIds'], ['publication', 'publicationIds'], ['run', 'runIds']])
      raw[kind] = (await db.query(SQL[kind], kind === 'task' ? pairs : [binding[pin], ...pairs])).rows
    for (const kind of ['publication', 'run']) check(raw[kind].every(row => row.bindingValid === true), 'database_binding')
    const rows = projectRows(scope, raw)
    const aliases = { task: (await db.query(SQL.taskAliases, pairs)).rows,
      publication: (await db.query(SQL.publicationAliases, [binding.publicationIds, ...pairs])).rows }
    const comparison = compareHistory(before, rows, aliases)
    const added = (await db.query(SQL.added, [...pairs, binding.publicationIds, binding.runIds])).rows[0]
    check(added && ['publications', 'runs'].every(key => Number.isSafeInteger(added[key]) && added[key] >= 0), 'sample_invalid')
    return { taskIds: binding.taskIds, rows, comparison, addedHistory: added, ledgerDigest: ledger.digest,
      readOnly: true, isolation: 'repeatable read', statementTimeoutMs: 20000, lockTimeoutMs: 2000 }
  } finally {
    if (begun) { await db.query('ROLLBACK'); observe({ transactionRolledBack: true }) }
  }
}

export async function authorizeFixedScope(client, before, email) {
  check(before.version === 2 && before.workspaceKind === 'team' && UUID.test(before.workspaceId)
    && DIGEST.test(before.readerSha256) && DIGEST.test(before.policyAdminSha256), 'sample_changed')
  const session = await client.json('/api/auth/get-session')
  check(typeof session?.user?.id === 'string' && hash(session.user.id) === before.readerSha256
    && session.user.email?.trim().toLowerCase() === email.trim().toLowerCase(), 'account_refused')
  const workspace = await client.json('/api/workspace?workspace=' + before.workspaceId)
  check(workspace?.currentUserId === session.user.id && workspace.workspace?.id === before.workspaceId
    && workspace.workspace.kind === 'team' && Array.isArray(workspace.members), 'workspace_refused')
  const admins = workspace.members.filter(row => typeof row?.userId === 'string' && hash(row.userId) === before.policyAdminSha256
    && row.role === 'admin' && row.status === 'active')
  check(admins.length === 1, 'workspace_refused')
  const scope = { ownerId: session.user.id, workspaceId: before.workspaceId, workspaceKind: 'team',
    adminId: admins[0].userId, taskIds: before.taskIds, taskOwners: {}, taskAccess: {} }
  // Recover only the frozen creator identities via individually authorized API
  // reads; neither the reader nor a SQL result may substitute a missing creator.
  for (const id of scope.taskIds) {
    const prior = before.snapshot.rows.task.find(row => row.id === id)
    const access = await readHistoryTaskAccess(client, scope, id)
    check(prior && hash(access.creator) === prior.creatorSha256, 'sample_changed')
    scope.taskOwners[id] = access.creator
    // This is the current normal API proof. A legitimate restore may change
    // the route; it never changes the frozen creator, tenant or history IDs.
    scope.taskAccess[id] = { mode: access.mode, deletedAt: access.deletedAt }
  }
  // The shared verifier repeats fresh membership, the fixed policy-admin
  // anchor, and every exact Task identity before any APP connection is opened.
  await verifyScope(client, scope)
  return scope
}

async function main(operation) {
  check(['check', 'capture'].includes(operation) && process.argv.length === 3, 'source_refused')
  checkBinding()
  const env = process.env
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16384 }).trim()
  guardContext(env, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')), git('rev-parse', 'HEAD'), git('status', '--porcelain', '--untracked-files=all') !== '')
  const source = await guardMain(env), before = await readBefore(env)
  await guardMain(env)
  if (operation === 'check') { console.log(JSON.stringify({ phase: 'after', mainSha: BINDING.applicationSha, beforeVerified: true })); return }
  const { email, password } = smokeAcceptanceAccount(env)
  let target
  try { target = new URL(env.MIKKA_DATABASE_URL) } catch { check(false, 'database_binding') }
  check(['postgres:', 'postgresql:'].includes(target.protocol) && target.hostname && target.pathname
    && hash('app-db-target\0' + target.hostname + '\0' + target.pathname) === before.databaseTargetSha256, 'database_binding')
  const { Pool } = createRequire(resolve(env.DOMAIN_HISTORY_DEPENDENCIES, 'package.json'))('pg')
  let cleaning = false
  const deadline = AbortSignal.timeout(100000)
  const client = createSessionClient(ORIGIN, (url, init) => fetch(url, { ...init,
    signal: cleaning ? AbortSignal.timeout(10000) : AbortSignal.any([deadline, init.signal, AbortSignal.timeout(10000)]) }))
  const report = { version: 2, issue: 1687, batch: 1782, phase: 'after', status: 'incomplete',
    opsSource: env.GITHUB_SHA, mainSha: BINDING.applicationSha, runId: env.GITHUB_RUN_ID, runAttempt: 1,
    sourceSha256: hash(await readFile(new URL(import.meta.url))), source, startedAt: new Date().toISOString(),
    before: { mainSha: BINDING.beforeMainSha, opsSource: BINDING.beforeOpsSource, runId: BINDING.beforeRunId,
      runAttempt: BINDING.beforeRunAttempt, artifactId: BINDING.artifactId, archiveSha256: BINDING.archiveSha256,
      evidenceSha256: BINDING.beforeSha256, receiptSha256: BINDING.receiptSha256 },
    databaseEvidence: {}, cleanup: { databaseConnectionClosed: false, transactionRolledBack: false, signedOut: false },
    limitations: ['bounded_sample_not_all_history', 'api_database_entity_match_not_vercel_environment_inspection',
      'normal_api_read_maintenance_writes_not_measured', 'workspace_database_not_read', 'active_run_snapshot_not_included'] }
  let pool, signedIn = false
  const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const login = await client.request('/api/auth/sign-in/email', post({ email, password, rememberMe: false }))
    signedIn = true; check(login.ok, 'account_refused')
    const scope = await authorizeFixedScope(client, before, email)
    report.workspaceId = scope.workspaceId; report.workspaceKind = scope.workspaceKind; report.taskIds = scope.taskIds
    report.readerSha256 = before.readerSha256; report.policyAdminSha256 = before.policyAdminSha256
    await guardMain(env)
    pool = new Pool({ connectionString: env.MIKKA_DATABASE_URL, max: 1, connectionTimeoutMillis: 15000,
      query_timeout: 25000, application_name: 'mikka-1782-domain-history-after', options: '-c default_transaction_read_only=on' })
    pool.on('error', () => { report.connectionError = true })
    const db = await pool.connect()
    try { report.snapshot = await snapshotAfter(db, scope, before, BINDING, evidence => {
      if (evidence.transactionRolledBack) report.cleanup.transactionRolledBack = true
      else Object.assign(report.databaseEvidence, evidence)
    }) }
    finally { db.release() }
    report.apiAuthorizationAfter = await verifyScope(client, scope)
    report.sourceAfter = await guardMain(env)
    check(!report.connectionError, 'database_failed')
    report.status = 'historical_sample_preserved'
  } catch (error) { report.status = 'failed'; report.failure = publicFailure(error) }
  finally {
    cleaning = true
    if (pool) { try { await pool.end(); report.cleanup.databaseConnectionClosed = true } catch { report.status = 'failed' } }
    else report.cleanup.databaseConnectionClosed = true
    if (signedIn) {
      try { const out = await client.request('/api/auth/sign-out', post({})); check(out.ok, 'signout_failed'); report.cleanup.signedOut = true }
      catch { report.status = 'failed'; report.cleanup.signoutFailure = true }
    }
    client.clear(); report.completedAt = new Date().toISOString()
    const output = resolve(env.RUNNER_TEMP, 'domain-history-after-1782')
    await mkdir(output, { recursive: true, mode: 0o700 })
    const bytes = JSON.stringify(report, null, 2) + '\n'
    await writeFile(resolve(output, 'after.json'), bytes, { mode: 0o600 })
    const receipt = { phase: 'after', status: report.status, opsSource: env.GITHUB_SHA, mainSha: BINDING.applicationSha,
      runId: env.GITHUB_RUN_ID, runAttempt: 1, evidenceSha256: hash(bytes), beforeArtifactId: BINDING.artifactId,
      comparison: report.snapshot?.comparison ?? null, cleanup: report.cleanup, ...(report.failure ? { failure: report.failure } : {}) }
    await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify(receipt))
  }
  if (report.status !== 'historical_sample_preserved') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv[2]).catch(error => { console.error(JSON.stringify(publicFailure(error))); process.exitCode = 1 })
