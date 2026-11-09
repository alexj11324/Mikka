import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createSessionClient } from '../acceptance/cloud-startup.mjs'
import { BINDING, checkBinding, guardContext, guardMain, assertBeforeIdentity, archiveEvidence,
  validateBefore, readBefore, SQL, compareHistory, snapshotAfter, authorizeFixedScope, publicFailure } from './domain-history-after-1782.mjs'
import { projectRows } from './domain-history-before-1782.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const hash = value => createHash('sha256').update(value).digest('hex')
const ownerId = 'synthetic-smoke-owner', workspaceId = id(90), taskIds = [id(1), id(2)], publicationIds = [id(3), id(4)]
const adminId = 'synthetic-policy-admin', taskOwners = { [id(1)]: ownerId, [id(2)]: 'synthetic-other-creator' }
const taskAccess = Object.fromEntries(taskIds.map(value => [value, { mode: 'live', deletedAt: null }]))
const scope = { ownerId, workspaceId, workspaceKind: 'team', adminId, taskIds, taskOwners, taskAccess }
const pairs = [taskIds, taskIds.map(value => taskOwners[value]), workspaceId]
const historyPairs = values => [values, ...pairs]
const sharedView = () => ({ currentUserId: ownerId, workspace: { id: workspaceId, kind: 'team' }, role: 'member',
  choices: [{ id: workspaceId, kind: 'team' }], members: [{ userId: ownerId, status: 'active', role: 'member' },
    { userId: adminId, email: 'alex@acme.aspectlylabs.com', status: 'active', role: 'admin' }] })
const raw = () => ({
  task: taskIds.map((value, index) => ({ id: value, owner: taskOwners[value], workspace: workspaceId, state: 'bound',
    scope: index ? 'personal' : 'workspace', identifier: index ? 'OLD-2' : '' })),
  publication: publicationIds.map((value, index) => ({ id: value, issueId: taskIds[index], bindingValid: true, identifier: 'PUB-' + index,
    branch: 'private-branch', baseBranch: 'main', remoteKey: 'private-repo' })),
  run: publicationIds.map((value, index) => ({ id: value, issueId: taskIds[index], bindingValid: true, hasProjectSnapshot: Boolean(index), frozenDigest: 'a'.repeat(32) })),
})
const aliases = () => ({ task: taskIds.map(value => ({ id: value, bound: true, valid: true })),
  publication: publicationIds.map(value => ({ id: value, applicable: true, valid: true })) })
const afterRaw = () => { const value = raw(); value.task[0].identifier = 'PUB-0'; return value }
const liveIssue = value => ({ issue: { id: value, userId: taskOwners[value], workspaceId,
  ownershipState: 'bound', scope: value === id(1) ? 'workspace' : 'personal' } })
function historyClient(reply = (_action, value) => liveIssue(value)) {
  const actions = []
  const client = createSessionClient('https://synthetic.invalid', async (url, init) => {
    if (url.pathname === '/mikka/api/auth/get-session') return Response.json({ user: { id: ownerId, email: 'synthetic@example.invalid' } })
    if (url.pathname === '/mikka/api/workspace') {
      assert.equal(url.searchParams.get('workspace'), workspaceId)
      return Response.json(sharedView())
    }
    assert.equal(url.pathname, '/mikka/api/rpc')
    const { action, args, version } = JSON.parse(init.body)
    assert.equal(version, 1); assert.equal(args.length, 1); assert.ok(taskIds.includes(args[0]))
    assert.equal(init.headers['x-mikka-rpc'], '1')
    assert.equal(init.headers['x-mikka-workspace-id'], workspaceId)
    assert.ok(['issues.getIssue', 'issue-operations.getDeletedIssue'].includes(action))
    actions.push({ action, id: args[0] })
    const result = reply(action, args[0])
    return result instanceof Response ? result : Response.json({ version: 1, ok: true, result })
  })
  return { client, actions }
}

function zip(entries) {
  return execFileSync('python3', ['-c', 'import base64,io,json,sys,zipfile\nout=io.BytesIO()\nwith zipfile.ZipFile(out,"w",compression=zipfile.ZIP_STORED) as z:\n for name,value in json.load(sys.stdin).items(): z.writestr(name,base64.b64decode(value))\nsys.stdout.buffer.write(out.getvalue())'],
    { input: JSON.stringify(Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')]))) })
}
function fixture({ beforeAccess = taskAccess, historyRows = raw() } = {}) {
  const ownedDeleted = Object.values(beforeAccess).filter(value => value.mode === 'owned_deleted').length
  const binding = { applicationSha: 'b'.repeat(40), beforeMainSha: 'a'.repeat(40), beforeOpsSource: 'c'.repeat(40),
    beforeCollectorSha256: 'd'.repeat(64), beforeRunId: 1234, beforeRunAttempt: 1, beforeWorkflowId: 4321,
    artifactId: 6789, artifactSizeBytes: 1, archiveSha256: 'e'.repeat(64), beforeSha256: 'f'.repeat(64), receiptSha256: '0'.repeat(64),
    taskIds, publicationIds: historyRows.publication.map(row => row.id), runIds: historyRows.run.map(row => row.id),
    workspaceId, workspaceKind: 'team', readerSha256: hash(ownerId),
    policyAdminSha256: hash(adminId), taskCreatorSha256: Object.fromEntries(taskIds.map(value => [value, hash(taskOwners[value])])) }
  const cleaned = { databaseConnectionClosed: true, transactionRolledBack: true, signedOut: true }
  const identity = { phase: 'before', status: 'captured_before', opsSource: binding.beforeOpsSource, mainSha: binding.beforeMainSha,
    runId: String(binding.beforeRunId), runAttempt: 1, cleanup: cleaned }
  const source = { mainSha: binding.beforeMainSha, servedBuild: binding.beforeMainSha, origin: 'https://app.aspectlylabs.com' }
  const before = { ...identity, version: 2, issue: 1687, batch: 1782, sourceSha256: binding.beforeCollectorSha256,
    before: source, after: source, workspaceId, workspaceKind: 'team', taskIds, readerSha256: hash(ownerId), policyAdminSha256: hash(adminId), databaseTargetSha256: hash('synthetic-target'),
    scope: 'at_most_ten_existing_shared_tasks_authorized_by_normal_api',
    selectionBasis: 'normal_api_policy_admin_workspace_own_thread_refs_and_per_task_detail_acl',
    apiAuthorization: { mode: 'shared_workspace_live_or_owner_deleted_detail_acl', allPassed: true,
      taskCount: 2, maximumConcurrentReads: 4, retries: 0 },
    apiTaskInventory: { selection: 'first_100_unique_task_refs_of_own_recent_threads', returnedRuns: 2,
      runLimitReached: false, maxRuns: 200, recentDays: 30, runsWithoutTask: 0, referencedTasks: 2,
      candidateCount: 2, discardedLaterTaskRefs: 0, maxCandidates: 100, authorizedLive: 2 - ownedDeleted, authorizedOwnedDeleted: ownedDeleted },
    databaseEvidence: { canonicalEpicMigrations: 0, legacyEpicMigrations: 0,
      normalApiAccessRechecked: true, authorizedLive: 2 - ownedDeleted, authorizedOwnedDeleted: ownedDeleted,
      historySelectionPolicy: 'collection_published_and_ended_with_coverage_anchors',
      selectedCoverage: { tasks: taskIds.length,
        publishedTasks: new Set(historyRows.publication.map(row => row.issueId)).size,
        endedTasks: new Set(historyRows.run.map(row => row.issueId)).size,
        projectSnapshotRuns: historyRows.run.filter(row => row.hasProjectSnapshot).length },
      publicationCounts: { receipts: 2, published: 2, runMissing: 0, issueMismatch: 0, executorMismatch: 0,
        workspaceNull: 0, workspaceDifferent: 0, verified: 2 },
      publicationClassification: 'published_receipts_first_failed_guard' },
    apiAuthorizationAfter: { live: 2 - ownedDeleted, ownedDeleted },
    snapshot: { taskIds, rows: projectRows({ ...scope, taskAccess: beforeAccess }, historyRows), ledgerDigest: '1'.repeat(32), readOnly: true, isolation: 'repeatable read' } }
  const beforeBytes = Buffer.from(JSON.stringify(before) + '\n'); binding.beforeSha256 = hash(beforeBytes)
  const receipt = { ...identity, evidenceSha256: binding.beforeSha256,
    counts: { task: historyRows.task.length, publication: historyRows.publication.length, run: historyRows.run.length } }
  const receiptBytes = Buffer.from(JSON.stringify(receipt) + '\n'); binding.receiptSha256 = hash(receiptBytes)
  const archive = zip({ 'before.json': beforeBytes, 'receipt.json': receiptBytes })
  binding.archiveSha256 = hash(archive); binding.artifactSizeBytes = archive.length
  const workflow = { id: binding.beforeWorkflowId, path: '.github/workflows/issue1782-domain-history-before.yml',
    name: 'Issue 1782 read-only domain history before', state: 'active' }
  const run = { id: binding.beforeRunId, run_attempt: 1, workflow_id: workflow.id, path: workflow.path, name: workflow.name,
    event: 'push', head_branch: 'ops/self-hosted-vault-closeout-20261108', head_sha: binding.beforeOpsSource,
    status: 'completed', conclusion: 'success', repository: { full_name: 'alexj11324/Mikka', id: 1427517699 },
    head_repository: { full_name: 'alexj11324/Mikka', id: 1427517699 }, actor: { login: 'alexj11324', id: 183887963 },
    triggering_actor: { login: 'alexj11324', id: 183887963 }, created_at: '2026-11-09T01:00:00.000Z', updated_at: '2026-11-09T01:10:00.000Z' }
  const artifact = { id: binding.artifactId, name: `domain-history-before-1782-${binding.beforeRunId}-1`,
    digest: 'sha256:' + binding.archiveSha256, size_in_bytes: binding.artifactSizeBytes, expired: false,
    created_at: '2026-11-09T01:09:00.000Z', expires_at: '2099-11-23T01:09:00.000Z', workflow_run: {
      id: run.id, head_sha: run.head_sha, head_branch: run.head_branch, repository_id: 1427517699, head_repository_id: 1427517699 } }
  return { binding, before, receipt, beforeBytes, receiptBytes, archive, workflow, run, artifact }
}

test('unbound production pins fail before any I/O; fixed unique frozen IDs are required', () => {
  assert.throws(() => checkBinding({ ...BINDING, applicationSha: null }), /binding_refused/)
  const { binding } = fixture(); checkBinding(binding)
  for (const change of [{ applicationSha: null }, { applicationSha: binding.beforeMainSha }, { beforeRunAttempt: 2 },
    { artifactSizeBytes: 3 * 1024 * 1024 }, { taskIds: [] }, { taskIds: [id(1), id(1)] }, { publicationIds: [id(4), id(3)] },
    { runIds: ['injection'] }, { receiptSha256: 'unknown' }]) assert.throws(() => checkBinding({ ...binding, ...change }))
})

test('only the real clean owned after job and attempt 1 are accepted', () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_ACTOR: 'alexj11324',
    GITHUB_TRIGGERING_ACTOR: 'alexj11324', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'e'.repeat(40), GITHUB_RUN_ID: '111',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'domain_history_after', GITHUB_REF: 'refs/heads/ops/self-hosted-vault-closeout-20261108',
    GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/issue1782-domain-history-after.yml@refs/heads/ops/self-hosted-vault-closeout-20261108' }
  const event = { ref: env.GITHUB_REF, after: env.GITHUB_SHA, forced: false, deleted: false,
    repository: { id: 1427517699, owner: { id: 183887963 } } }
  guardContext(env, event, env.GITHUB_SHA, false)
  for (const change of [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_ACTOR: 'other' }, { GITHUB_TRIGGERING_ACTOR: 'other' },
    { GITHUB_JOB: 'domain_history_before' }, { GITHUB_WORKFLOW_REF: 'other' }, { GITHUB_RUN_ATTEMPT: '2' }])
    assert.throws(() => guardContext({ ...env, ...change }, event, env.GITHUB_SHA, false))
  assert.throws(() => guardContext(env, { ...event, forced: true }, env.GITHUB_SHA, false))
  assert.throws(() => guardContext(env, event, 'f'.repeat(40), false))
  assert.throws(() => guardContext(env, event, env.GITHUB_SHA, true))
})

test('actual main and served build both match M, production fetch never receives GitHub token', async () => {
  const { binding } = fixture()
  for (const drift of ['', 'main', 'build']) {
    const fake = async (url, init) => {
      assert.equal(init.redirect, 'error')
      if (url.includes('api.github.com')) return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: drift === 'main' ? 'f'.repeat(40) : binding.applicationSha } })
      assert.equal(init.headers.authorization, undefined)
      return Response.json({ build: drift === 'build' ? 'f'.repeat(40) : binding.applicationSha })
    }
    if (drift) await assert.rejects(guardMain({ GITHUB_TOKEN: 'synthetic' }, binding, fake))
    else assert.equal((await guardMain({ GITHUB_TOKEN: 'synthetic' }, binding, fake)).servedBuild, binding.applicationSha)
  }
})

test('before run, actor, attempt, source, artifact ID/digest/expiry and collector receipt must agree', () => {
  const good = fixture(); assertBeforeIdentity(good.binding, good.workflow, good.run, good.artifact)
  for (const mutate of [x => x.run.run_attempt++, x => { x.run.head_sha = '0'.repeat(40) }, x => { x.run.actor.id = 1 },
    x => { x.run.conclusion = 'failure' }, x => { x.workflow.path = '.github/workflows/other.yml' },
    x => x.artifact.id++, x => { x.artifact.digest = 'sha256:' + 'f'.repeat(64) }, x => { x.artifact.expired = true },
    x => { x.artifact.workflow_run.head_branch = 'main' }]) {
    const value = structuredClone(good); mutate(value)
    assert.throws(() => assertBeforeIdentity(value.binding, value.workflow, value.run, value.artifact))
  }
  assert.deepEqual(validateBefore(good.before, good.receipt, good.binding), good.before)
  for (const mutate of [x => { x.before.cleanup.signedOut = false }, x => { x.before.sourceSha256 = 'e'.repeat(64) },
    x => { x.receipt.evidenceSha256 = 'e'.repeat(64) }, x => { x.before.taskIds = [id(9)] },
    x => { x.before.snapshot.rows.run[0].frozenDigest = 'raw' }, x => { x.before.snapshot.rows.task[0].issuedIdentifierPresent = true },
    x => { x.before.snapshot.rows.publication[0].raw = 'private' }, x => x.receipt.counts.run++]) {
    const value = structuredClone(good); mutate(value)
    assert.throws(() => validateBefore(value.before, value.receipt, value.binding))
  }
})

test('before evidence binds the Shared Workspace kind independently of legacy Task scope labels', () => {
  const { before, receipt, binding } = fixture()
  assert.equal(validateBefore(before, receipt, binding).workspaceKind, 'team')
  for (const workspaceKind of [undefined, null, true, 'personal', 'workspace', 'TEAM']) {
    assert.throws(() => validateBefore({ ...before, workspaceKind }, receipt, binding), /before_projection/)
  }
})

test('shared v2 freezes reader, policy admin and each distinct creator; v1 cannot be relabeled', () => {
  const good = fixture()
  for (const mutate of [value => { value.before.version = 1 }, value => { delete value.before.readerSha256 },
    value => { value.before.readerSha256 = hash('another-reader') }, value => { value.before.policyAdminSha256 = hash('another-admin') },
    value => { value.before.databaseEvidence.legacyEpicMigrations = 1 }, value => { value.before.databaseEvidence.canonicalEpicMigrations = 1 },
    value => { value.before.snapshot.rows.task[1].creatorSha256 = hash(ownerId) },
    value => { value.binding.taskCreatorSha256 = { [id(1)]: hash(ownerId) } }]) {
    const next = structuredClone(good); mutate(next)
    assert.throws(() => validateBefore(next.before, next.receipt, next.binding))
  }
  assert.notEqual(good.before.snapshot.rows.task[0].creatorSha256, good.before.snapshot.rows.task[1].creatorSha256)
})

test('complete collection accepts publication and ended Run on separate authorized Tasks through the bound ZIP', () => {
  const historyRows = raw()
  historyRows.publication = historyRows.publication.slice(0, 1)
  historyRows.run = historyRows.run.slice(1)
  const good = fixture({ historyRows })
  assert.notEqual(good.before.snapshot.rows.publication[0].issueId, good.before.snapshot.rows.run[0].issueId)
  assert.deepEqual(good.before.databaseEvidence.selectedCoverage,
    { tasks: 2, publishedTasks: 1, endedTasks: 1, projectSnapshotRuns: 1 })
  assert.deepEqual(archiveEvidence(good.archive, good.binding), good.before)
  assert.deepEqual(good.binding.publicationIds, [id(3)])
  assert.deepEqual(good.binding.runIds, [id(4)])
})

test('collection coverage rejects missing history, padded Tasks, unknown policy and inaccurate closed counts', () => {
  const good = fixture()
  for (const mutate of [
    value => { value.before.snapshot.rows.publication = [] },
    value => { value.before.snapshot.rows.run = [] },
    value => { for (const kind of ['publication', 'run'])
      for (const row of value.before.snapshot.rows[kind]) row.issueId = id(1) },
    value => { delete value.before.databaseEvidence.historySelectionPolicy },
    value => { value.before.databaseEvidence.historySelectionPolicy = 'per_task_published_and_ended' },
    value => { delete value.before.databaseEvidence.selectedCoverage },
    value => { value.before.databaseEvidence.selectedCoverage.extra = 0 },
    ...['tasks', 'publishedTasks', 'endedTasks', 'projectSnapshotRuns'].flatMap(key => [
      value => { value.before.databaseEvidence.selectedCoverage[key]++ },
      value => { value.before.databaseEvidence.selectedCoverage[key] = String(value.before.databaseEvidence.selectedCoverage[key]) },
      value => { delete value.before.databaseEvidence.selectedCoverage[key] },
    ]),
  ]) {
    const value = structuredClone(good); mutate(value)
    assert.throws(() => validateBefore(value.before, value.receipt, value.binding), /before_projection/)
  }
})

test('ZIP and both inner digests bind the actual immutable before bytes', () => {
  const good = fixture(); assert.deepEqual(archiveEvidence(good.archive, good.binding), good.before)
  assert.throws(() => archiveEvidence(good.archive, { ...good.binding, beforeSha256: 'f'.repeat(64) }), /before_digest/)
  const extra = zip({ 'before.json': good.beforeBytes, 'receipt.json': good.receiptBytes, '../escape': 'not extracted' })
  assert.throws(() => archiveEvidence(extra, { ...good.binding, archiveSha256: hash(extra), artifactSizeBytes: extra.length }), /before_archive/)
  const corrupt = Buffer.from(good.archive), offset = corrupt.indexOf(good.receiptBytes)
  assert.ok(offset >= 0); corrupt[offset + 1] ^= 1
  assert.throws(() => archiveEvidence(corrupt, { ...good.binding, archiveSha256: hash(corrupt) }), /before_archive/)
})

test('artifact storage gets no token and an upstream attempt change after download is refused', async () => {
  const good = fixture()
  for (const drift of [false, true]) {
    let reads = 0
    const fake = async (url, init) => {
      if (url.includes('/actions/workflows/')) return Response.json(good.workflow)
      if (url.includes('/actions/runs/')) return Response.json({ ...good.run, run_attempt: ++reads > 1 && drift ? 2 : 1 })
      if (url.endsWith('/zip')) return new Response(null, { status: 302, headers: { location: 'https://productionresultssa0.blob.core.windows.net/synthetic' } })
      if (url.includes('api.github.com')) return Response.json(good.artifact)
      assert.equal(init.headers, undefined); assert.equal(init.redirect, 'error')
      return new Response(good.archive)
    }
    if (drift) await assert.rejects(readBefore({ GITHUB_TOKEN: 'synthetic' }, good.binding, fake), /before_identity/)
    else assert.deepEqual(await readBefore({ GITHUB_TOKEN: 'synthetic' }, good.binding, fake), good.before)
  }
})

test('first issuance is permitted with correct alias while every old nonempty identifier stays exact', () => {
  const { before } = fixture(), rows = projectRows(scope, afterRaw())
  const result = compareHistory(before, rows, aliases())
  assert.deepEqual({ existing: result.existingIdentifiersPreserved, issued: result.firstIdentifiersVerified }, { existing: 1, issued: 1 })
  const changed = structuredClone(rows); changed.task[1].issuedIdentifierSha256 = hash('rewritten')
  assert.throws(() => compareHistory(before, changed, aliases()), /history_changed/)
  const missing = structuredClone(rows); missing.task[0].issuedIdentifierPresent = false
  assert.throws(() => compareHistory(before, missing, aliases()), /identifier_missing/)
})

for (const [name, mutate] of [
  ['missing publication', x => x.rows.publication.pop()], ['missing ended Run', x => x.rows.run.pop()],
  ['publication renumber', x => { x.rows.publication[0].identifierSha256 = 'd'.repeat(64) }],
  ['publication branch rewrite', x => { x.rows.publication[0].branchSha256 = 'd'.repeat(64) }],
  ['frozen execution rewrite', x => { x.rows.run[0].frozenDigest = 'd'.repeat(32) }],
  ['project snapshot removed', x => { x.rows.run[1].hasProjectSnapshot = false }],
  ['workspace moved', x => { x.rows.task[0].workspaceId = id(98) }],
  ['original creator changed', x => { x.rows.task[0].creatorSha256 = hash('changed-creator') }],
  ['quarantined Task', x => { x.alias.task[0].bound = false }],
  ['issued alias wrong owner or tenant', x => { x.alias.task[0].valid = false }],
  ['trusted publication alias missing', x => { x.alias.publication[0].valid = false }],
]) test('rejects ' + name + ' instead of declaring historical preservation', () => {
  const { before } = fixture(), value = { rows: projectRows(scope, afterRaw()), alias: aliases() }
  mutate(value); assert.throws(() => compareHistory(before, value.rows, value.alias))
})

test('untrusted publication is preserved but never requires adopting a foreign-owner alias', () => {
  const { before } = fixture(), alias = aliases()
  alias.publication[0] = { id: id(3), applicable: false, valid: false }
  const result = compareHistory(before, projectRows(scope, afterRaw()), alias)
  assert.equal(result.publicationAliasesNotApplicable, 1)
  assert.equal(result.trustedPublicationAliasesVerified, 1)
})

function database({ settings = { readonly: 'on', isolation: 'repeatable read' }, failRun = false,
  tenant = true, wrongOwner = false, access = taskAccess, authorizedAccess = taskIds.length,
  added = { publications: 4, runs: 7 } } = {}) {
  const calls = [], rows = afterRaw()
  if (wrongOwner) rows.task[0].owner = 'foreign-owner'
  return { calls, query: async (sql, args) => {
    calls.push({ sql, args })
    if (sql === SQL.settings) return { rows: [settings] }
    if (sql === SQL.ledger) return { rows: [{ epic: tenant ? 9 : 8, legacy: 0, digest: 'd'.repeat(32) }] }
    if (sql === SQL.taskAccess) {
      assert.deepEqual(args, [...pairs, taskIds.map(value => access[value].mode), taskIds.map(value => access[value].deletedAt), ownerId])
      return { rows: [{ present: taskIds.length, authorized: authorizedAccess }] }
    }
    if (sql === SQL.task) { assert.deepEqual(args, pairs); return { rows: rows.task } }
    if (sql === SQL.publication) { assert.deepEqual(args, historyPairs(publicationIds)); return { rows: rows.publication } }
    if (sql === SQL.run) { assert.deepEqual(args, historyPairs(publicationIds)); if (failRun) throw Error('private-db-error'); return { rows: rows.run } }
    if (sql === SQL.taskAliases) { assert.deepEqual(args, pairs); return { rows: aliases().task } }
    if (sql === SQL.publicationAliases) { assert.deepEqual(args, historyPairs(publicationIds)); return { rows: aliases().publication } }
    if (sql === SQL.added) { assert.deepEqual(args, [...pairs, publicationIds, publicationIds]); return { rows: [added] } }
    return { rows: [] }
  } }
}

test('real SQL contract queries original IDs independent of current status and records new history separately', async () => {
  const { before, binding } = fixture(), db = database(), result = await snapshotAfter(db, scope, before, binding)
  assert.equal(result.readOnly, true); assert.deepEqual(result.addedHistory, { publications: 4, runs: 7 })
  assert.deepEqual(result.comparison.preserved, { task: 2, publication: 2, run: 2 })
  assert.equal(db.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  assert.ok(db.calls.every(call => !/^\s*(INSERT|UPDATE|DELETE|COMMIT|CREATE|ALTER|DROP)\b/i.test(call.sql)))
  assert.ok(!/status|LIMIT|ORDER BY.*LIMIT/.test(SQL.publication)); assert.ok(!/status|LIMIT/.test(SQL.run))
  assert.match(SQL.publication, /WHERE p\."runId"=ANY\(\$1::uuid\[\]\)/)
  assert.match(SQL.run, /WHERE r.id=ANY\(\$1::uuid\[\]\)/)
})

for (const kind of ['publication', 'run']) test('a frozen ' + kind + ' with changed binding stays visible and causes failure', async () => {
  const { before, binding } = fixture(), db = database(), query = db.query
  db.query = async (sql, args) => {
    const value = await query(sql, args)
    if (sql === SQL[kind]) value.rows[0].bindingValid = false
    return value
  }
  await assert.rejects(snapshotAfter(db, scope, before, binding), error => error.code === 'database_binding')
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  assert.match(SQL[kind], /LEFT JOIN tasks/)
  assert.match(SQL[kind], /AS "bindingValid"/)
  assert.match(SQL[kind], /unnest\(\$2::uuid\[\], \$3::text\[\]\)/)
})

test('before reader and per-Task creator substitutions fail before opening APP', async () => {
  const { before, binding } = fixture()
  for (const changed of [{ ...scope, ownerId: 'another-reader' }, { ...scope, adminId: 'another-admin' },
    { ...scope, taskOwners: { [id(1)]: ownerId, [id(2)]: ownerId } }]) {
    const db = database()
    await assert.rejects(snapshotAfter(db, changed, before, binding), error => error.code === 'database_binding')
    assert.equal(db.calls.length, 0)
  }
})

for (const [name, input] of [['read-write transaction', { settings: { readonly: 'off', isolation: 'repeatable read' } }],
  ['wrong isolation', { settings: { readonly: 'on', isolation: 'read committed' } }],
  ['query failure', { failRun: true }], ['missing migration', { tenant: false }], ['wrong owner', { wrongOwner: true }]])
  test('rolls back and refuses ' + name, async () => {
    const { before, binding } = fixture(), db = database(input)
    const evidence = []
    await assert.rejects(snapshotAfter(db, scope, before, binding, value => evidence.push(value)))
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
    assert.deepEqual(evidence.at(-1), { transactionRolledBack: true })
  })

test('an unacknowledged ROLLBACK is never recorded as successful cleanup', async () => {
  const { before, binding } = fixture(), db = database(), execute = db.query, evidence = []
  db.query = (sql, args) => { if (sql === 'ROLLBACK') throw Error('synthetic rollback refusal'); return execute(sql, args) }
  await assert.rejects(snapshotAfter(db, scope, before, binding, value => evidence.push(value)))
  assert.ok(!evidence.some(value => value.transactionRolledBack))
})

test('normal per-ID API authorizes frozen old Tasks with the explicit Workspace header and no new selection', async () => {
  const { before } = fixture()
  const client = (missing = false) => historyClient((action, value) => {
    assert.equal(action, 'issues.getIssue')
    const result = liveIssue(value)
    if (missing && value === id(2)) result.issue.id = id(99)
    return result
  }).client
  assert.deepEqual(await authorizeFixedScope(client(), before, 'synthetic@example.invalid'), scope)
  await assert.rejects(authorizeFixedScope(client(true), before, 'synthetic@example.invalid'))
  await assert.rejects(authorizeFixedScope(client(), { ...before, readerSha256: hash('other') }, 'synthetic@example.invalid'))
  for (const workspaceKind of [undefined, 'personal']) {
    const noTaskRead = historyClient(() => assert.fail('invalid frozen Workspace kind reached a Task read')).client
    await assert.rejects(authorizeFixedScope(noTaskRead, { ...before, workspaceKind }, 'synthetic@example.invalid'), /sample_changed/)
  }
})

for (const [name, change] of [
  ['creator changed after before', issue => ({ ...issue, userId: ownerId })],
  ['Task moved to another Workspace', issue => ({ ...issue, workspaceId: id(99) })],
  ['Task became pending', issue => ({ ...issue, ownershipState: 'pending' })],
]) test(name + ' is refused during normal API creator recovery', async () => {
  const { before } = fixture()
  const client = historyClient((action, value) => {
    assert.equal(action, 'issues.getIssue')
    return { issue: change(liveIssue(value).issue) }
  }).client
  await assert.rejects(authorizeFixedScope(client, before, 'synthetic@example.invalid'), error => error.code === 'sample_changed')
})

test('a changed policy admin is refused before recovering any Task creator', async () => {
  const { before } = fixture()
  const client = historyClient(() => assert.fail('a changed policy admin reached Task reads')).client
  await assert.rejects(authorizeFixedScope(client, { ...before, policyAdminSha256: hash('another-admin') }, 'synthetic@example.invalid'),
    error => error.code === 'workspace_refused')
})

const deletedAt = '2026-11-08T11:22:33.444Z'
const ownedAccess = { ...taskAccess, [id(1)]: { mode: 'owned_deleted', deletedAt } }

test('owner-deleted history uses the real session transport and keeps the full publication and Run proof', async () => {
  const { before, binding } = fixture({ beforeAccess: ownedAccess })
  const transport = historyClient((action, value) => action === 'issues.getIssue'
    ? value === id(1) ? { error: 'issueNotFound', params: { $mikka: 'undefined' } } : liveIssue(value)
    : { id: value, title: 'private-deleted-title', deletedAt })
  const authorized = await authorizeFixedScope(transport.client, before, 'synthetic@example.invalid')
  assert.deepEqual(authorized.taskOwners, taskOwners)
  assert.deepEqual(authorized.taskAccess, ownedAccess)
  assert.equal(transport.actions.filter(value => value.action === 'issue-operations.getDeletedIssue').length, 2)
  const evidence = [], result = await snapshotAfter(database({ access: ownedAccess }), authorized, before, binding, row => evidence.push(row))
  assert.deepEqual(result.comparison.preserved, { task: 2, publication: 2, run: 2 })
  assert.equal(result.rows.task[0].accessMode, 'owned_deleted')
  assert.equal(result.rows.task[0].deletedAtSha256, hash(deletedAt))
  assert.ok(evidence.some(row => row.normalApiAccessRechecked === true && row.authorizedOwnedDeleted === 1))
  assert.ok(!JSON.stringify(result).includes(deletedAt)); assert.ok(!JSON.stringify(result).includes('private-deleted-title'))
})

test('a normally authorized restore changes access evidence without rewriting frozen history', async () => {
  const { before, binding } = fixture({ beforeAccess: ownedAccess }), frozen = structuredClone(before)
  const transport = historyClient((action, value) => { assert.equal(action, 'issues.getIssue'); return liveIssue(value) })
  const authorized = await authorizeFixedScope(transport.client, before, 'synthetic@example.invalid')
  assert.deepEqual(authorized.taskAccess, taskAccess)
  const result = await snapshotAfter(database(), authorized, before, binding)
  assert.deepEqual(result.comparison.preserved, { task: 2, publication: 2, run: 2 })
  assert.equal(result.rows.task[0].accessMode, 'live'); assert.equal(result.rows.task[0].deletedAtSha256, null)
  assert.deepEqual(result.rows.publication, before.snapshot.rows.publication)
  assert.deepEqual(result.rows.run, before.snapshot.rows.run)
  assert.deepEqual(before, frozen)
})

test('before access provenance rejects missing, invented or non-owner deleted proofs', () => {
  const good = fixture()
  const owned = fixture({ beforeAccess: ownedAccess })
  validateBefore(owned.before, owned.receipt, owned.binding)
  for (const mutate of [row => { delete row.accessMode }, row => { row.accessMode = 'arbitrary' },
    row => { row.deletedAtSha256 = hash(deletedAt) }, row => { row.accessMode = 'owned_deleted' },
    row => { row.accessMode = 'owned_deleted'; row.deletedAtSha256 = 'not-a-digest' }]) {
    const next = structuredClone(good); mutate(next.before.snapshot.rows.task[0])
    assert.throws(() => validateBefore(next.before, next.receipt, next.binding), /before_projection/)
  }
  const other = structuredClone(good)
  Object.assign(other.before.snapshot.rows.task[1], { accessMode: 'owned_deleted', deletedAtSha256: hash(deletedAt) })
  assert.throws(() => validateBefore(other.before, other.receipt, other.binding), /before_projection/)
  for (const field of ['apiAuthorization', 'databaseEvidence']) {
    const next = structuredClone(good)
    if (field === 'apiAuthorization') next.before.apiAuthorization.allPassed = false
    else next.before.databaseEvidence.normalApiAccessRechecked = false
    assert.throws(() => validateBefore(next.before, next.receipt, next.binding), /before_projection/)
  }
})

for (const [name, response] of [['generic action failure', { error: 'generic' }],
  ['auth refusal', { error: 'authRequired' }], ['HTTP not-found', new Response('{}', { status: 404 })],
  ['malformed missing issue', {}]]) test(name + ' never becomes a deleted-Task authorization', async () => {
  const { before } = fixture(), transport = historyClient(action => {
    assert.equal(action, 'issues.getIssue', 'a non-issueNotFound result reached the deleted endpoint')
    return response
  })
  await assert.rejects(authorizeFixedScope(transport.client, before, 'synthetic@example.invalid'))
  assert.equal(transport.actions.length, 1)
})

for (const [name, deleted] of [['null deleted proof', null], ['wrong deleted Task ID', { id: id(99), deletedAt }],
  ['invalid deleted timestamp', { id: id(1), deletedAt: 'not-a-date' }]]) test(name + ' cannot open the history read', async () => {
  const { before } = fixture(), transport = historyClient(action => action === 'issues.getIssue'
    ? { error: 'issueNotFound' } : deleted)
  await assert.rejects(authorizeFixedScope(transport.client, before, 'synthetic@example.invalid'), /sample_changed/)
})

test('owner-only deleted proof cannot replace another frozen Task creator', async () => {
  const { before } = fixture(), transport = historyClient((action, value) => action === 'issues.getIssue'
    ? value === id(2) ? { error: 'issueNotFound' } : liveIssue(value)
    : { id: value, title: 'not-an-owner-proof', deletedAt, userId: 'invented-owner', workspaceId })
  await assert.rejects(authorizeFixedScope(transport.client, before, 'synthetic@example.invalid'), /sample_changed/)
})

test('a stale API deletion proof fails the same-transaction database guard before history rows and rolls back', async () => {
  const { before, binding } = fixture({ beforeAccess: ownedAccess })
  const db = database({ access: ownedAccess, authorizedAccess: 1 }), evidence = []
  await assert.rejects(snapshotAfter(db, { ...scope, taskAccess: ownedAccess }, before, binding, row => evidence.push(row)), /database_binding/)
  assert.ok(!db.calls.some(value => [SQL.publication, SQL.run].includes(value.sql)))
  assert.deepEqual(evidence.at(-1), { transactionRolledBack: true })
})

test('owner-deleted access cannot turn missing published history into a complete before', () => {
  const rows = raw(); rows.publication = []
  assert.throws(() => projectRows({ ...scope, taskAccess: ownedAccess }, rows), /history_missing/)
})

test('unknown errors remain closed and never contain private URL/error text', () => {
  assert.deepEqual(publicFailure(Object.assign(Error('postgres://user:password@private/db'), { code: '42P01' })), { code: 'after_failed' })
  assert.deepEqual(publicFailure({ code: 'history_changed' }), { code: 'history_changed' })
})

test('workflow stays disabled while unbound and keeps existing OIDC subject, exact keys and no publisher permissions', async () => {
  const text = await readFile(new URL('../../.github/workflows/issue1782-domain-history-after.yml', import.meta.url), 'utf8')
  let bound = false
  try { checkBinding(BINDING); bound = true } catch { /* Inactive draft must remain unable to request a credential. */ }
  if (!bound) assert.match(text, /false &&/)
  assert.match(text, /group: production-smoke-owner-acceptance/)
  assert.match(text, /actions: read/); assert.ok(!/actions: write|contents: write|E2B_API_KEY|VERCEL_TEAM_TOKEN|DATABASE_URL\s*$/.test(text))
  for (const key of ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD', 'MIKKA_DATABASE_URL'])
    assert.equal((text.match(new RegExp('secret-name: ' + key + '\n', 'g')) ?? []).length, 1)
  assert.ok(text.indexOf('node --test') < text.indexOf('uses: Infisical'))
  const pgGate = text.indexOf('node --test scripts/ops/domain-history-after-1782.db.test.mjs')
  assert.ok(pgGate > text.indexOf('npm install --prefix') && pgGate < text.indexOf('uses: Infisical'))
  assert.match(text, /image: postgres:17\n/)
  assert.match(text, /127\.0\.0\.1:5432:5432/)
  assert.doesNotMatch(text, /continue-on-error/)
  assert.ok(!/env:\n(?: {6}.+\n)* {6}DOMAIN_HISTORY_DEPENDENCIES:/.test(text), 'runner.temp is step context, never job.env')
})

test('the after PG gate rejects absent, remote and inherited production targets without loading a driver', () => {
  const file = new URL('./domain-history-after-1782.db.test.mjs', import.meta.url)
  for (const additions of [{}, { DOMAIN_HISTORY_TEST_DATABASE_URL: 'postgresql://e2e:e2e-local-only@remote.invalid:5432/mikka_domain_history_1782_fixture' },
    { DOMAIN_HISTORY_TEST_DATABASE_URL: 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/mikka_domain_history_1782_fixture', MIKKA_DATABASE_URL: 'synthetic-production' },
    { DOMAIN_HISTORY_TEST_DATABASE_URL: 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/mikka_domain_history_1782_fixture', DATABASE_URL: 'synthetic-production' }]) {
    const env = { PATH: process.env.PATH, DOMAIN_HISTORY_DEPENDENCIES: '/must-not-load-driver' }
    let output = ''
    assert.throws(() => execFileSync(process.execPath, ['--test', file.pathname], { env: { ...env, ...additions }, encoding: 'utf8',
      timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }), error => {
      output = String(error.stdout) + String(error.stderr); return error.status !== 0
    })
    assert.match(output, /fixture_target_refused/)
    assert.doesNotMatch(output, /fixture_driver_missing/)
  }
})
