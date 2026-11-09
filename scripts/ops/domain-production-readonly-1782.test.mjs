import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { archiveEvidence, assertActiveIdentity, authorize, BINDING, checkBinding, checkWindowBinding, closeResources, compareDatabases,
  guardContext, guardMain, projectActive, projectMetadata, publicFailure, readActive, readDatabase, validateActive, WINDOW, windowRecord } from './domain-production-readonly-1782.mjs'
import { checkWindow, guardWindowContext, guardWindowScope } from './domain-history-before-1782.mjs'
import { COUNTERS, LEDGER, SQL } from './domain-production-readonly-1782-sql.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const hash = value => createHash('sha256').update(value).digest('hex')
const ownerId = 'synthetic-reader', adminId = 'synthetic-policy-admin', email = 'synthetic@example.invalid'
const at = Date.parse('2026-11-09T20:10:00.000Z')
const activationCondition = "    if: github.repository == 'alexj11324/Mikka' && github.actor == 'alexj11324' && github.ref == 'refs/heads/ops/self-hosted-vault-closeout-20261108' && github.run_attempt == 1\n"
const selection = { projectId: id(100), environmentId: id(200), projectRevision: 2, policyRevision: 1, environmentRevision: 3,
  repositoryKey: 'v2/github.com/synthetic/repository', baseBranch: 'main', runtime: 'cloud', harness: 'any' }
function fixture() {
  const binding = { applicationSha: 'a'.repeat(40), readerSha256: hash(ownerId), policyAdminSha256: hash(adminId), workspaceId: id(900),
    activeRunId: 1234, activeRunAttempt: 1, activeWorkflowId: 5678, activeActor: { login: 'github-actions[bot]', id: 41898282 },
    activeTriggeringActor: { login: 'github-actions[bot]', id: 41898282 }, artifactId: 12345, artifactSizeBytes: 1,
    archiveSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64), cases: ['claude', 'codex'].map((value, index) => ({ case: value,
      taskId: id(index + 1), runIds: [id(index + 11)], selection: { projectId: selection.projectId, environmentId: selection.environmentId,
        projectRevision: 2, policyRevision: 1, environmentRevision: 3, repositorySha256: hash(selection.repositoryKey),
        baseBranchSha256: hash(JSON.stringify(selection.baseBranch)), runtime: 'cloud', harness: 'any' } })) }
  const report = { version: 1, issue: 1687, mode: 'active', origin: 'https://app.aspectlylabs.com', applicationSha: binding.applicationSha,
    status: 'execution_observed_pending_snapshot_review', cleanup: { sessionClosed: true, workspaceRestored: true, errors: [] },
    preflight: { workspaceId: binding.workspaceId, activeScopeVerified: true },
    team: { teamWorkspaceConfirmed: true, teamAdminMembershipVerified: true, teamWorkspaceHash: hash('team-workspace\0' + binding.workspaceId) },
    privateRawContent: 'sensitive-report-content', cases: binding.cases.map((pin, index) => ({ case: pin.case, issueId: pin.taskId,
      runId: pin.runIds[0], runIds: pin.runIds, harness: index ? 'codex' : 'claude_code', model: index ? 'gpt-6-luna' : 'claude-haiku-5-5',
      status: 'execution_observed', submitted: true, dispatchSettled: true, toolObserved: true, repositoryObserved: true, reportObserved: true,
      selection: { ...selection }, cleanup: { status: 'passed', tasksRetained: true, errors: [], machines: pin.runIds.map(runId => ({ runId, state: 'ended' })) },
      runs: pin.runIds.map(runId => ({ runId, harness: index ? 'codex' : 'claude_code', model: index ? 'gpt-6-luna' : 'claude-haiku-5-5',
        status: 'succeeded', credentialType: 'subscription', sharedIdentityVerified: true, route: index ? 'codex_cli' : 'claude_code_cli' })) })) }
  return { binding, report }
}
function windowFixture(binding = fixture().binding) {
  const window = { workspaceId: binding.workspaceId, readerSha256: binding.readerSha256, opsParentSha: 'c'.repeat(40),
    commentId: 3456, commentBodySha256: null, startsAt: '2026-11-09T20:05:00.000Z', expiresAt: '2026-11-09T20:24:00.000Z' }
  const comment = { id: window.commentId, issue_url: 'https://api.github.com/repos/alexj11324/Mikka/issues/1752',
    user: { id: 183887963, login: 'alexj11324' },
    body: '<!-- mikka-1782-domain-production-readonly:v1\n' + JSON.stringify(windowRecord(binding, window)) + '\n-->' }
  window.commentBodySha256 = hash(comment.body)
  return { window, comment }
}
function sourceFixture(change = () => {}) {
  const { binding } = fixture(), { window, comment } = windowFixture(binding), calls = []
  const data = { main: { ref: 'refs/heads/main', object: { type: 'commit', sha: binding.applicationSha } },
    version: { build: binding.applicationSha }, issue: { number: 1752, comments: 17 }, comments: [comment] }
  change(data, window, binding)
  const read = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/git/ref/heads/main')) return Response.json(data.main)
    if (url.startsWith('https://app.aspectlylabs.com/mikka/api/version?verify=')) return Response.json(data.version)
    if (url.endsWith('/issues/1752')) return Response.json(data.issue)
    assert.equal(url, 'https://api.github.com/repos/alexj11324/Mikka/issues/1752/comments?per_page=1&page=' + data.issue.comments)
    return Response.json(data.comments)
  }
  return { binding, window, calls, data, read }
}
function zip(value, extra = false) {
  return execFileSync('python3', ['-c', `import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',compression=zipfile.ZIP_STORED) as z:\n z.writestr('report.json',sys.stdin.buffer.read())\n ${extra ? "z.writestr('../other.json',b'{}')" : 'pass'}\nsys.stdout.buffer.write(b.getvalue())\n`],
    { input: Buffer.from(JSON.stringify(value)), maxBuffer: 2 * 1024 * 1024 })
}
function zipped(extra = false) {
  const f = fixture(), bytes = zip(f.report, extra)
  f.binding.artifactSizeBytes = bytes.length; f.binding.archiveSha256 = hash(bytes); f.binding.reportSha256 = hash(JSON.stringify(f.report))
  return { ...f, bytes }
}
function metadata(binding) {
  return [
    { id: binding.activeWorkflowId, name: 'Production smoke', path: '.github/workflows/production-smoke.yml', state: 'active' },
    { id: binding.activeRunId, run_attempt: 1, workflow_id: binding.activeWorkflowId, path: '.github/workflows/production-smoke.yml', name: 'Production smoke',
      event: 'workflow_dispatch', head_branch: 'main', head_sha: binding.applicationSha, status: 'completed', conclusion: 'success',
      repository: { full_name: 'alexj11324/Mikka', id: 1427517699, owner: { id: 183887963 } }, head_repository: { id: 1427517699 },
      actor: binding.activeActor, triggering_actor: binding.activeTriggeringActor },
    { id: binding.artifactId, name: 'production-work-domain-' + binding.activeRunId, expired: false,
      size_in_bytes: binding.artifactSizeBytes, digest: 'sha256:' + binding.archiveSha256, expires_at: '2099-01-01T00:00:00Z',
      workflow_run: { id: binding.activeRunId, head_sha: binding.applicationSha, head_branch: 'main', repository_id: 1427517699, head_repository_id: 1427517699 } },
  ]
}
const scopeFixture = () => { const f = fixture(); return { ...f, scope: { ...validateActive(f.report, f.binding), ownerId } } }
const metadataRows = kind => ({ ledger: LEDGER[kind].map(pair => ({ name: pair[0], appliedAt: new Date('2026-11-09T00:00:00Z') })),
  digest: { count: '100', digest: 'a'.repeat(32) }, counts: { ...Object.fromEntries(COUNTERS[kind].map(key => [key, '0'])), unknownRepairDigest: 'b'.repeat(32) } })
function activeRows(scope) {
  return {
    app: { tasks: scope.taskIds.map(id => ({ id, tenant: true, owner: true, bound: true, identified: true, identifierDigest: 'c'.repeat(32) })),
      cases: Object.fromEntries(scope.cases.map(item => [item.case, item.runIds.map(id => ({ id, issueId: item.taskId,
        tenant: true, owner: true, ended: true, succeeded: true, structured: true, snapshotTenant: true, snapshotProject: true, snapshotRepository: true,
        snapshotBranch: true, snapshotEnvironment: true, snapshotRuntime: true, snapshotHarness: true, environmentStructure: true,
        projectRevision: '2', policyRevision: '1', environmentRevision: '3', environmentDigest: 'd'.repeat(32),
        projectExecutionDigest: 'e'.repeat(32), frozenDigest: 'f'.repeat(32), rawDefinition: 'must-not-escape' }))])) },
    ws: { membership: { count: '1' }, links: scope.taskIds.map(issueId => ({ issueId, project: true, tenant: true })),
      cases: Object.fromEntries(scope.cases.map(item => [item.case, [{ id: item.selection.projectId, tenant: true, active: true,
        branch: true, environment: true, linked: true, environmentActive: true, policyAllowed: true, environmentStructure: true,
        projectRevision: 2, policyRevision: 1, environmentRevision: 3, environmentDigest: 'd'.repeat(32), configuration: 'must-not-escape' }]])) },
  }
}
function database(kind, scope, { readonly = 'on', failQuery, failRollback = false } = {}) {
  const calls = [], raw = activeRows(scope)[kind], meta = metadataRows(kind)
  return { calls, query: async (sql, args) => {
    calls.push({ sql, args })
    if (sql === failQuery || sql === 'ROLLBACK' && failRollback) throw Error('private-provider-message')
    if (sql === SQL.settings) return { rows: [{ readonly, isolation: 'repeatable read' }] }
    if (sql === SQL.ledger) { assert.deepEqual(args, [LEDGER[kind].flat()]); return { rows: meta.ledger } }
    if (sql === SQL.ledgerDigest) return { rows: [meta.digest] }
    if (sql === SQL[kind + 'Counts']) return { rows: [meta.counts] }
    if (kind === 'app' && sql === SQL.appTasks) { assert.deepEqual(args, [scope.taskIds, scope.workspaceId, ownerId]); return { rows: raw.tasks } }
    if (kind === 'app' && sql === SQL.appRuns) {
      const item = scope.cases.find(item => item.runIds[0] === args[0][0]); assert.ok(item)
      const s = item.selection
      assert.deepEqual(args, [item.runIds, scope.workspaceId, ownerId, s.projectId, s.repositoryKey, s.baseBranch, s.environmentId, s.runtime, s.harness])
      return { rows: raw.cases[item.case] }
    }
    if (kind === 'ws' && sql === SQL.wsMembership) { assert.deepEqual(args, [scope.workspaceId, ownerId]); return { rows: [raw.membership] } }
    if (kind === 'ws' && sql === SQL.wsLinks) { assert.equal(args[2], scope.workspaceId); return { rows: raw.links.filter(row => args[0].includes(row.issueId)) } }
    if (kind === 'ws' && sql === SQL.wsResource) { assert.equal(args[1], scope.workspaceId); return { rows: raw.cases.claude } }
    assert.ok(!args, 'unexpected query cannot cross database roles')
    return { rows: [] }
  } }
}

test('default binding is wholly null and refuses before any request or credential use; complete reviewed activation stays testable', async () => {
  const values = [...Object.values(BINDING), ...Object.values(WINDOW)]
  if (values.some(value => value === null)) {
    assert.ok(values.every(value => value === null), 'partial compiled activation must fail this same suite')
    let calls = 0
    await assert.rejects(guardMain({}, BINDING, async () => { calls++ }))
    await assert.rejects(readActive({}, BINDING, async () => { calls++ }))
    assert.equal(calls, 0)
  } else { checkBinding(); checkWindowBinding() }
  const { binding } = fixture(); checkBinding(binding)
  for (const change of [{ applicationSha: 'wrong' }, { activeRunAttempt: 2 }, { workspaceId: id(901), extraSql: 'SELECT private' },
    { activeActor: { login: 'another-user', id: 12 } }]) assert.throws(() => checkBinding({ ...binding, ...change }))
  binding.cases[1].runIds = binding.cases[0].runIds; assert.throws(() => checkBinding(binding))
})

test('only the real owned Ops push and exact workflow can run the collector', () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/ops/self-hosted-vault-closeout-20261108',
    GITHUB_EVENT_NAME: 'push', GITHUB_ACTOR: 'alexj11324', GITHUB_TRIGGERING_ACTOR: 'alexj11324', GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'domain_production_readonly', GITHUB_SHA: 'b'.repeat(40),
    GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/issue1782-domain-production-readonly.yml@refs/heads/ops/self-hosted-vault-closeout-20261108' }
  const event = { repository: { id: 1427517699, owner: { id: 183887963 } }, ref: env.GITHUB_REF, after: env.GITHUB_SHA, forced: false, deleted: false }
  guardContext(env, event, env.GITHUB_SHA, false)
  for (const change of [{ GITHUB_ACTOR: 'other' }, { GITHUB_TRIGGERING_ACTOR: 'other' }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_JOB: 'private_candidates' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('domain-production-readonly', 'domain-history-before') }]) assert.throws(() => guardContext({ ...env, ...change }, event, env.GITHUB_SHA, false))
  assert.throws(() => guardContext(env, { ...event, forced: true }, env.GITHUB_SHA, false))
  assert.throws(() => guardContext(env, event, env.GITHUB_SHA, true))
})

test('main and publicly served version both bind M without forwarding GitHub authorization', async () => {
  for (const changed of [null, 'main', 'served']) {
    const f = sourceFixture(data => { if (changed === 'main') data.main.object.sha = 'b'.repeat(40)
      if (changed === 'served') data.version.build = 'b'.repeat(40) })
    if (changed) await assert.rejects(guardMain({ GITHUB_TOKEN: 'synthetic' }, f.binding, f.read, f.window, () => at))
    else await guardMain({ GITHUB_TOKEN: 'synthetic' }, f.binding, f.read, f.window, () => at)
    if (f.calls.length > 1) assert.equal(f.calls[1].init.headers.authorization, undefined)
  }
})

test('the imported finite window contract binds one ordinary Ops child and the same actual account scope', () => {
  const { binding } = fixture(), { window } = windowFixture(binding)
  checkWindowBinding(binding, window)
  guardWindowContext({ before: window.opsParentSha }, [window.opsParentSha], window)
  guardWindowScope({ ownerId, workspaceId: binding.workspaceId }, window)
  for (const [event, parents] of [[{ before: 'd'.repeat(40) }, [window.opsParentSha]],
    [{ before: window.opsParentSha }, ['d'.repeat(40)]], [{ before: window.opsParentSha }, [window.opsParentSha, 'd'.repeat(40)]]]) {
    assert.throws(() => guardWindowContext(event, parents, window), { code: 'window_source_changed' })
  }
  for (const patch of [{ workspaceId: id(901) }, { readerSha256: hash('another-reader') }]) {
    assert.throws(() => checkWindowBinding(binding, { ...window, ...patch }), { code: 'window_scope_changed' })
  }
  assert.throws(() => guardWindowScope({ ownerId: 'another-reader', workspaceId: binding.workspaceId }, window), { code: 'window_scope_changed' })
})

test('every partial, oversized or noncanonical compiled window is refused before network use', () => {
  const { binding } = fixture(), { window } = windowFixture(binding)
  for (const patch of [{ opsParentSha: null }, { commentId: 0 }, { commentBodySha256: 'short' },
    { startsAt: '2026-11-09T20:05:00Z' }, { expiresAt: window.startsAt }, { expiresAt: '2026-11-09T20:26:00.000Z' },
    { extraMode: 'anything' }]) assert.throws(() => checkWindow({ ...window, ...patch }), { code: 'window_unbound' })
})

test('latest owner comment binds this source, reader, active run and exact active artifact', async () => {
  const f = sourceFixture()
  const result = await guardMain({ GITHUB_TOKEN: 'synthetic' }, f.binding, f.read, f.window, () => at, 4 * 60000)
  assert.equal(result.windowCommentId, f.window.commentId); assert.equal(result.opsParentSha, f.window.opsParentSha)
  assert.equal(result.windowExpiresAt, f.window.expiresAt); assert.equal(f.calls.length, 4)
  assert.equal(windowRecord(f.binding, f.window).artifactId, f.binding.artifactId)
  assert.equal(windowRecord(f.binding, f.window).archiveSha256, f.binding.archiveSha256)
})

for (const [name, change] of [
  ['different latest comment', d => { d.comments[0].id++ }],
  ['different numeric owner', d => { d.comments[0].user.id++ }],
  ['another issue', d => { d.comments[0].issue_url = 'https://api.github.com/repos/alexj11324/Mikka/issues/1503' }],
  ['body changed', d => { d.comments[0].body += '\nreleased' }],
  ['released semantic record', (d, w) => { d.comments[0].body = d.comments[0].body.replace('"active"', '"released"'); w.commentBodySha256 = hash(d.comments[0].body) }],
  ['different active artifact', (d, w, b) => { d.comments[0].body = d.comments[0].body.replace('"artifactId":' + b.artifactId, '"artifactId":99999'); w.commentBodySha256 = hash(d.comments[0].body) }],
  ['duplicate marker', (d, w) => { d.comments[0].body += '\n' + d.comments[0].body; w.commentBodySha256 = hash(d.comments[0].body) }],
]) test('actual account window refuses ' + name, async () => {
  const f = sourceFixture(change)
  await assert.rejects(guardMain({ GITHUB_TOKEN: 'synthetic' }, f.binding, f.read, f.window, () => at), { code: 'window_changed' })
})

test('expired, future and insufficient windows refuse all network access, and expiry during reads is checked again', async () => {
  for (const [now, remaining] of [[Date.parse('2026-11-09T20:04:59.999Z'), 0], [Date.parse('2026-11-09T20:24:00.000Z'), 0], [at, 14 * 60000]]) {
    const f = sourceFixture()
    await assert.rejects(guardMain({ GITHUB_TOKEN: 'synthetic' }, f.binding, f.read, f.window, () => now, remaining), { code: 'window_expired' })
    assert.equal(f.calls.length, 0)
  }
  const f = sourceFixture(); let clockReads = 0
  await assert.rejects(guardMain({ GITHUB_TOKEN: 'synthetic' }, f.binding, f.read, f.window,
    () => ++clockReads === 1 ? at : Date.parse(f.window.expiresAt)), { code: 'window_expired' })
  assert.equal(f.calls.length, 4)
})

test('the actual active run event, branch, actor, source and artifact are checked independently', () => {
  const { binding } = fixture(), [workflow, run, artifact] = metadata(binding)
  assertActiveIdentity(binding, workflow, run, artifact)
  for (const change of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'other' }, { event: 'push' }, { conclusion: 'failure' },
    { actor: { login: 'alexj11324', id: 183887963 } }, { run_attempt: 2 }]) assert.throws(() => assertActiveIdentity(binding, workflow, { ...run, ...change }, artifact))
  assert.throws(() => assertActiveIdentity(binding, workflow, run, { ...artifact, expired: true }))
  assert.throws(() => assertActiveIdentity(binding, { ...workflow, path: 'other.yml' }, run, artifact))
})

for (const [name, change] of [
  ['wrong tenant', report => { report.preflight.workspaceId = id(999) }],
  ['different Task', report => { report.cases[0].issueId = id(99) }],
  ['extra Run', report => { report.cases[0].runIds.push(id(98)) }],
  ['uncertain dispatch', report => { report.cases[0].dispatchSettled = false }],
  ['fake machine cleanup', report => { report.cases[0].cleanup.machines[0].state = 'running' }],
  ['unknown profile creation', report => { report.cases[0].createdProfile = { confirmed: false } }],
  ['missing session cleanup', report => { report.cleanup.sessionClosed = false }],
  ['wrong repository', report => { report.cases[0].selection.repositoryKey = 'v2/github.com/other/private' }],
  ['wrong source', report => { report.applicationSha = 'b'.repeat(40) }],
  ['foreign model', report => { report.cases[0].runs[0].model = 'unapproved-model' }],
]) test('active evidence refuses ' + name, () => { const { binding, report } = fixture(); change(report); assert.throws(() => validateActive(report, binding)) })

test('primary producer must match its case while an independent checker may use the other approved model', () => {
  const { binding, report } = fixture(), item = report.cases[0]
  const wrongPrimary = { ...item.runs[0], harness: 'codex', model: 'gpt-6-luna', route: 'codex_cli' }
  item.runs[0] = wrongPrimary
  assert.throws(() => validateActive(report, binding), error => error.code === 'active_report')
  item.runs[0] = { ...wrongPrimary, harness: 'claude_code', model: 'claude-haiku-5-5', route: 'claude_code_cli' }
  const checkerId = id(21)
  binding.cases[0].runIds.push(checkerId); item.runIds = [...binding.cases[0].runIds]
  item.runs.push({ ...wrongPrimary, runId: checkerId }); item.cleanup.machines.push({ runId: checkerId, state: 'ended' })
  assert.deepEqual(validateActive(report, binding).cases[0].runIds, [id(11), checkerId])
})

test('the exact archive digest, member set, report digest and CRC must all agree', () => {
  const { binding, bytes } = zipped()
  const scope = archiveEvidence(bytes, binding)
  assert.equal(scope.taskIds.length, 2); assert.ok(!JSON.stringify(scope).includes('sensitive-report-content'))
  assert.throws(() => archiveEvidence(bytes, { ...binding, reportSha256: 'c'.repeat(64) }))
  const extra = zipped(true); assert.throws(() => archiveEvidence(extra.bytes, extra.binding), error => error.code === 'active_archive')
  const corrupt = Buffer.from(bytes); const at = corrupt.indexOf('sensitive-report-content'); assert.ok(at > 0); corrupt[at] ^= 1
  assert.throws(() => archiveEvidence(corrupt, { ...binding, archiveSha256: hash(corrupt) }), error => error.code === 'active_archive')
})

test('signed artifact storage receives no GitHub credentials and hostile redirects are refused', async () => {
  const { binding, bytes } = zipped(), [workflow, run, artifact] = metadata(binding)
  for (const hostile of [false, true]) {
    let storageReads = 0
    const fetchImpl = async (url, init) => {
      if (url.includes('blob.core.windows.net')) { storageReads++; assert.equal(init.headers, undefined); return new Response(bytes) }
      assert.ok(url.startsWith('https://api.github.com/repos/alexj11324/Mikka/'))
      if (url.endsWith('/zip')) return new Response(null, { status: 302, headers: { location: hostile ? 'https://other.invalid/secret' : 'https://productionresultssa1.blob.core.windows.net/synthetic' } })
      return Response.json(url.includes('/workflows/') ? workflow : url.includes('/runs/') ? run : artifact)
    }
    if (hostile) await assert.rejects(readActive({ GITHUB_TOKEN: 'synthetic' }, binding, fetchImpl))
    else await readActive({ GITHUB_TOKEN: 'synthetic' }, binding, fetchImpl)
    assert.equal(storageReads, hostile ? 0 : 1)
  }
})

function apiClient(scope) {
  return { json: async path => path.includes('get-session') ? { user: { id: ownerId, email } } : {
    currentUserId: ownerId, workspace: { id: scope.workspaceId, kind: 'team' }, role: 'member', choices: [{ id: scope.workspaceId, kind: 'team' }],
    members: [{ userId: ownerId, role: 'member', status: 'active' }, { userId: adminId, role: 'admin', status: 'active', email: 'alex@acme.aspectlylabs.com' }] },
  rpc: async (action, args, options) => {
    assert.deepEqual(options, { headers: { 'x-mikka-workspace-id': scope.workspaceId } })
    if (action === 'issues.getIssue') return { issue: { id: args[0], userId: ownerId, workspaceId: scope.workspaceId,
      ownershipState: 'bound', scope: 'personal', projectId: selection.projectId } }
    assert.equal(action, 'project-resources.listProjectResources'); assert.deepEqual(args, [scope.workspaceId, selection.projectId])
    return { policy: { mode: 'inherit' }, repositories: [{ repositoryKey: selection.repositoryKey, baseBranch: 'main', environmentId: selection.environmentId }],
      environments: [{ id: selection.environmentId, workspaceId: scope.workspaceId, archivedAt: null,
        configuration: { runtime: 'cloud', harness: 'any', repositoryKeys: [], variables: { PRIVATE: 'not-for-output' } } }],
      environmentBindings: [{ environmentId: selection.environmentId, isDefault: true }], createdBy: 'another-project-creator' }
  } }
}
test('normal API authorization accepts a legitimate Project creator while retaining exact reader, Workspace and Tasks', async () => {
  const { binding, scope } = scopeFixture(), result = await authorize(apiClient(scope), email, scope, binding)
  assert.equal(result.ownerId, ownerId); assert.ok(!JSON.stringify(result).includes('not-for-output'))
})
for (const [name, mutate] of [
  ['Task creator', issue => { issue.userId = 'other' }], ['Task tenant', issue => { issue.workspaceId = id(901) }],
  ['Task state', issue => { issue.ownershipState = 'pending' }], ['Task Project', issue => { issue.projectId = id(102) }],
]) test('normal API rejects changed ' + name + ' before any SQL', async () => {
  const { binding, scope } = scopeFixture(), client = apiClient(scope), original = client.rpc
  client.rpc = async (...args) => { const result = await original(...args); if (result.issue) mutate(result.issue); return result }
  let databaseOpened = false
  await assert.rejects((async () => { await authorize(client, email, scope, binding); databaseOpened = true })())
  assert.equal(databaseOpened, false)
})

test('metadata uses only known ledger names, preserves unknown-repair counts and refuses missing migration evidence', () => {
  const data = metadataRows('app'); data.counts.unknownRepair = '3'; data.counts.rawReason = 'private-reason'
  const projected = projectMetadata('app', data.ledger, data.digest, data.counts)
  assert.ok(projected.findings.includes('app.unknownRepair')); assert.equal(projected.counts.unknownRepair, '3')
  assert.ok(!JSON.stringify(projected).includes('private-reason'))
  assert.throws(() => projectMetadata('app', data.ledger.slice(1), data.digest, data.counts))
  assert.throws(() => projectMetadata('app', [...data.ledger, { name: 'unapproved.sql', appliedAt: new Date() }], data.digest, data.counts))
})

test('APP and WS use separate fixed read-only transactions and actual rollback ACKs', async () => {
  const { binding, scope } = scopeFixture()
  for (const kind of ['app', 'ws']) {
    const db = database(kind, scope), observed = [], result = await readDatabase(kind, db, scope, binding, value => observed.push(value))
    assert.equal(result.readOnly, true); assert.equal(db.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK'); assert.equal(observed.at(-1).transactionRolledBack, true)
    assert.ok(db.calls.every(row => !/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COMMIT)\b/i.test(row.sql)))
    assert.ok(!JSON.stringify(result).includes('must-not-escape'))
  }
})
test('failed SQL or failed rollback cannot manufacture a successful cleanup flag', async () => {
  const { binding, scope } = scopeFixture()
  for (const options of [{ readonly: 'off' }, { failQuery: SQL.appRuns }, { failQuery: SQL.appRuns, failRollback: true }]) {
    const db = database('app', scope, options), observed = []
    await assert.rejects(readDatabase('app', db, scope, binding, value => observed.push(value)))
    assert.equal(observed.some(value => value.transactionRolledBack === true), !options.failRollback)
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  }
})
for (const [name, mutate] of [
  ['APP tenant', raw => { raw.app.tasks[0].tenant = false }],
  ['Run association', raw => { raw.app.cases.claude[0].issueId = id(2) }],
  ['frozen Project', raw => { raw.app.cases.claude[0].snapshotProject = false }],
  ['frozen environment', raw => { raw.app.cases.claude[0].snapshotEnvironment = false }],
  ['WS membership', raw => { raw.ws.membership.count = '0' }],
  ['WS Task link', raw => { raw.ws.links[0].tenant = false }],
]) test('closed database projections refuse wrong ' + name, () => {
  const { scope } = scopeFixture(), raw = activeRows(scope); mutate(raw)
  assert.throws(() => { projectActive('app', scope, raw.app); projectActive('ws', scope, raw.ws) })
})

test('same-revision environment mismatch fails; later revision drift remains a visible finding', () => {
  const { scope } = scopeFixture(), raw = activeRows(scope), meta = { findings: [] }
  const app = { metadata: meta, active: projectActive('app', scope, raw.app) }, ws = { metadata: meta, active: projectActive('ws', scope, raw.ws) }
  assert.equal(compareDatabases(app, ws).status, 'metadata_and_active_snapshot_verified')
  ws.active.cases[0].environmentDigest = 'a'.repeat(32)
  assert.throws(() => compareDatabases(app, ws), error => error.code === 'active_snapshot')
  ws.active.cases[0].environmentRevision++; ws.active.cases[0].revisionDrift = ['environmentRevision']
  const compared = compareDatabases(app, ws)
  assert.equal(compared.status, 'collected_with_findings'); assert.ok(compared.findings.includes('active.claude.revision_drift'))
})
test('connection close, sign-out and cookie clear follow actual calls even if prior flags claim success', async () => {
  const cleanup = { app: { connectionClosed: true }, ws: { connectionClosed: true }, signedOut: true, sessionCleared: true }, calls = []
  const pools = { app: { end: async () => { calls.push('app'); throw Error('private-error') } }, ws: { end: async () => { calls.push('ws') } } }
  const client = { request: async () => { calls.push('signout'); return { ok: false } }, clear: () => { calls.push('clear') } }
  assert.equal(await closeResources(pools, client, true, cleanup), false)
  assert.deepEqual(calls, ['app', 'ws', 'signout', 'clear'])
  assert.equal(cleanup.app.connectionClosed, false); assert.equal(cleanup.ws.connectionClosed, true)
  assert.equal(cleanup.signedOut, false); assert.equal(cleanup.sessionCleared, true)
  assert.deepEqual(publicFailure(Error('postgres://user:secret@private/production')), { code: 'collection_failed' })
})

test('workflow stays disabled until fully bound and grants only exact read keys after source/artifact verification', async () => {
  const source = await readFile(new URL('../../.github/workflows/issue1782-domain-production-readonly.yml', import.meta.url), 'utf8')
  if ([...Object.values(BINDING), ...Object.values(WINDOW)].every(value => value === null)) assert.match(source, /    if: false\n/)
  else { checkWindowBinding(); assert.ok(source.includes(activationCondition)) }
  assert.match(source, /group: production-smoke-owner-acceptance/)
  assert.match(source, /actions: read/); assert.doesNotMatch(source, /actions: write|contents: write|E2B_API_KEY|continue-on-error/)
  assert.match(source, /issues: read/); assert.match(source, /fetch-depth: 2/)
  assert.ok(source.indexOf('mjs check') < source.indexOf('uses: Infisical'))
  assert.match(source, /image: postgres:17\n/); assert.match(source, /127\.0\.0\.1:5432:5432/)
  assert.match(source, /DOMAIN_READONLY_TEST_DATABASE_URL: postgresql:\/\/e2e:e2e-local-only@127\.0\.0\.1:5432\/mikka_domain_metadata_1782_fixture\n/)
  const pgGate = source.indexOf('node --test scripts/ops/domain-production-readonly-1782.db.test.mjs')
  assert.ok(pgGate > source.indexOf('pg@8.16.3') && pgGate < source.indexOf('uses: Infisical'))
  assert.ok(pgGate < source.indexOf('mjs check'), 'all real PG cases run before an unbound/expired window can refuse credentials')
  for (const name of ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD', 'MIKKA_DATABASE_URL', 'DATABASE_URL']) assert.equal((source.match(new RegExp('secret-name: ' + name + '\n', 'g')) ?? []).length, 1)
  assert.doesNotMatch(source.slice(0, source.indexOf('    steps:')), /\$\{\{\s*runner\./)
})

test('PG fixture rejects every nonexact target and inherited production binding before pg or any connection', () => {
  const target = 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/mikka_domain_metadata_1782_fixture'
  for (const env of [{}, { DOMAIN_READONLY_TEST_DATABASE_URL: 'postgresql://synthetic@production.invalid/database' },
    { DOMAIN_READONLY_TEST_DATABASE_URL: target.replace('127.0.0.1', 'localhost') },
    { DOMAIN_READONLY_TEST_DATABASE_URL: target + '?sslmode=disable' },
    { DOMAIN_READONLY_TEST_DATABASE_URL: target, DATABASE_URL: 'synthetic-production-binding' },
    { DOMAIN_READONLY_TEST_DATABASE_URL: target, MIKKA_DATABASE_URL: 'synthetic-production-binding' }]) {
    const result = spawnSync(process.execPath, ['--test', new URL('./domain-production-readonly-1782.db.test.mjs', import.meta.url).pathname],
      { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 1)
    assert.match(result.stdout + result.stderr, /fixture_target_refused/)
    assert.doesNotMatch(result.stdout + result.stderr, /fixture_driver_missing|ECONNREFUSED/)
  }
})
