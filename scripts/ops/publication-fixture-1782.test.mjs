import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createSessionClient } from '../acceptance/cloud-startup.mjs'
import { BINDING, MODEL, FIXTURE_PATH, FIXTURE_SHA256, assertRequest, checkBinding, cleanup, dispatch,
  fixtureDocument, guardContext, guardMain, newState, pinResources, publicationReceipt, publicFailure,
  validateFactory, verifyOldRun, windowRecord } from './publication-fixture-1782.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const hash = value => createHash('sha256').update(value).digest('hex')
const reader = 'synthetic-reader', admin = 'synthetic-admin'
const at = Date.parse('2026-11-09T20:01:00.000Z')
const text = await readFile(new URL('./publication-fixture-1782.md', import.meta.url), 'utf8')
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/ops/self-hosted-vault-closeout-20261108', GITHUB_ACTOR: 'alexj11324', GITHUB_TRIGGERING_ACTOR: 'alexj11324',
  GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '6789', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'publication_fixture',
  GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/issue1782-publication-fixture.yml@refs/heads/ops/self-hosted-vault-closeout-20261108',
  GITHUB_TOKEN: 'synthetic-never-output' }
function binding() {
  const b = { applicationSha: 'a'.repeat(40), workspaceId: id(1), readerSha256: hash(reader), policyAdminSha256: hash(admin),
    opsParentSha: 'c'.repeat(40), preflightRunId: 1234, preflightOpsSource: 'd'.repeat(40), preflightEvidenceSha256: 'e'.repeat(64),
    botId: id(2), botCreationReceiptSha256: 'f'.repeat(64), chatChoiceId: id(3), subscriptionConnectionId: id(4),
    profileId: id(5), profileVersion: 3, profileDigest: '9'.repeat(64),
    reviewProfilePins: [{ id: id(5), version: 3, digest: '9'.repeat(64), harness: MODEL.harness, model: MODEL.model, connectionId: id(4) }],
    repositoryBaseSha: 'f'.repeat(40), oldRunWitness: { taskId: id(7), runId: id(8), createdAt: '2026-11-08T17:00:00.000Z',
      observedAt: '2026-11-09T19:55:00.000Z', observedStatus: 'succeeded', creatorSha256: hash(reader), accessMode: 'live', deletedAtSha256: null },
    windowCommentId: 3456, windowCommentBodySha256: null, windowStartsAt: '2026-11-09T20:00:00.000Z', windowExpiresAt: '2026-11-09T20:44:00.000Z' }
  const comment = { id: 3456, user: { login: 'alexj11324', id: 183887963 }, issue_url: 'https://api.github.com/repos/alexj11324/Mikka/issues/1752',
    body: '<!-- mikka-1782-publication-fixture:v1\n' + JSON.stringify(windowRecord(b)) + '\n-->' }
  b.windowCommentBodySha256 = hash(comment.body)
  return { b, comment }
}
function resources(change = () => {}) {
  const { b } = binding(), calls = [], scope = { ownerId: reader, adminId: admin, workspaceId: b.workspaceId }
  const profile = { id: b.profileId, version: b.profileVersion, digest: b.profileDigest, enabled: true, archivedAt: null,
    harness: MODEL.harness, model: { mode: 'fixed', ...MODEL, source: { kind: 'subscription', connectionId: b.subscriptionConnectionId } },
    instructions: '', roles: [], skills: [] }
  const data = { github: { viewerId: reader, connected: true, installed: true, repositories: [{ fullName: 'alexj11324/Mikka-handoff' }] },
    management: { profiles: [profile], availability: { [b.profileId]: { available: true } } },
    order: { candidates: [{ harness: MODEL.harness, model: MODEL.model, source: { kind: 'subscription', connectionId: b.subscriptionConnectionId }, credentialOwnerId: admin }] },
    bots: { live: { ownerId: reader, workspaceId: b.workspaceId }, items: [{ id: b.botId }] },
    keys: { apiKeyAfterQuota: false }, bot: { id: b.botId }, chat: { botId: b.botId, enabled: true, working: false, streamRunId: null },
    menu: { groups: [{ kind: 'subscription', provider: MODEL.provider, owner: 'never-output-admin-name', options: [{ id: b.chatChoiceId, modelId: MODEL.model, provider: MODEL.provider }] }],
      current: { id: b.chatChoiceId, kind: 'subscription', provider: MODEL.provider, modelId: MODEL.model, chosen: true, available: true } },
    threads: { items: [{ id: b.oldRunWitness.runId, issueId: b.oldRunWitness.taskId, createdAt: b.oldRunWitness.createdAt, status: 'succeeded', prompt: 'never-output-old-prompt' }] } }
  change(data, b)
  const client = { json: async (path, init) => {
    calls.push(path)
    if (path === '/api/integrations/github') return data.github
    if (path.startsWith('/api/factory/agent-profiles?')) return data.management
    if (path.startsWith('/api/settings/api-keys?')) return data.keys
    if (path === '/api/bots/' + b.botId) return data.bot
    if (path === '/api/rpc') {
      const body = JSON.parse(init.body)
      assert.equal(body.version, 1); assert.equal(body.action, 'issues.getIssue')
      assert.deepEqual(body.args, [b.oldRunWitness.taskId])
      assert.equal(new Headers(init.headers).get('x-mikka-workspace-id'), b.workspaceId)
      return { ok: true, result: { issue: { id: body.args[0], userId: reader, workspaceId: b.workspaceId,
        ownershipState: 'bound', scope: 'workspace' } } }
    }
    assert.fail('unexpected read ' + path)
  }, rpc: async (action, args) => {
    calls.push(action)
    if (action === 'model-order.getModelOrder') { assert.deepEqual(args, [b.workspaceId]); return data.order }
    if (action === 'bots.pollBots') return data.bots
    if (action === 'coordinator.pollCoordinatorChat') return data.chat
    if (action === 'execution-settings.getBotModelMenu') return data.menu
    if (action === 'task-runs.pollThreads') return data.threads
    assert.fail('unexpected RPC ' + action)
  } }
  return { b, scope, client, data, calls }
}
function factoryFixture() {
  const { b } = binding(), scope = { ownerId: reader, adminId: admin, workspaceId: b.workspaceId }
  const record = { issueId: id(20), runId: id(21), submissionId: id(22), submitted: true, dispatchSettled: true }
  const snapshot = { task: { id: id(23), issueId: record.issueId, userId: reader, workspaceId: b.workspaceId, botId: b.botId,
    sourceEventId: id(24), revision: 3, candidateId: id(25), status: 'pending' },
    attempts: [{ taskId: id(23), runId: record.runId, output: { requestEpoch: id(24) } }],
    candidates: [{ id: id(25), taskId: id(23), runId: record.runId, kind: 'repository', sha: '7'.repeat(40),
      repository: 'https://github.com/alexj11324/Mikka-handoff.git', scope: 'issue:' + record.issueId }] }
  const flow = { version: 2, id: id(23), issueId: record.issueId, botId: b.botId,
    pullRequest: { url: 'https://github.com/alexj11324/Mikka-handoff/pull/123', state: 'open' } }
  return { b, scope, record, snapshot, flow }
}

test('draft is unbound and disabled while valid fully reviewed compiled bindings remain accepted', async () => {
  const values = Object.values(BINDING)
  if (values.some(v => v === null)) { assert.ok(values.every(v => v === null)); assert.throws(() => checkBinding());
    assert.match(await readFile(new URL('../../.github/workflows/issue1782-publication-fixture.yml', import.meta.url), 'utf8'), /    if: false\n/) }
  else checkBinding()
  assert.equal(checkBinding(binding().b).profileVersion, 3)
  for (const patch of [{ profileVersion: 0 }, { botId: null }, { repositoryBaseSha: 'main' }, { readerSha256: reader },
    { windowExpiresAt: '2026-11-09T21:00:00.000Z' }, { oldRunWitness: { ...binding().b.oldRunWitness, observedAt: '2026-11-09T20:01:00.000Z' } },
    { reviewProfilePins: [] }]) assert.throws(() => checkBinding({ ...binding().b, ...patch }), { code: 'binding_refused' })
})
test('fixed useful document and command contract permit one exact new file, real PR marker and successful checks', () => {
  const doc = fixtureDocument(binding().b, text, env.GITHUB_SHA)
  assert.equal(hash(text), FIXTURE_SHA256); assert.match(doc.submissionId, /^[a-f0-9-]{36}$/)
  for (const value of [FIXTURE_PATH, FIXTURE_SHA256, '非 force push', 'checks SUCCESS', '<!-- mikka-issue:Task UUID -->', '不是存量历史']) assert.ok(JSON.stringify(doc.content).includes(value))
  assert.throws(() => fixtureDocument(binding().b, text + '\n', env.GITHUB_SHA), { code: 'fixture_bytes_changed' })
})
test('normal resource reads bind exact owned Bot, unique shared chat choice/source and fixed Profile version before Task creation', async () => {
  const f = resources(); assert.equal((await pinResources(f.client, f.scope, f.b)).id, f.b.profileId)
  assert.equal(f.calls.length, 8)
})
for (const [name, mutate] of [
  ['foreign reader', d => { d.github.viewerId = 'other' }], ['repository absent', d => { d.github.repositories = [] }],
  ['wrong Workspace', d => { d.bots.live.workspaceId = id(99) }], ['borrowed Bot', d => { d.bots.items = [] }],
  ['busy Bot', d => { d.chat.working = true }], ['ambiguous subscription', d => { d.order.candidates.push({ ...d.order.candidates[0] }) }],
  ['other subscription owner', d => { d.order.candidates[0].credentialOwnerId = 'other' }],
  ['different selected chat', d => { d.menu.current.id = id(99) }], ['chat fallback', d => { d.menu.current.fallback = 'quota' }],
  ['paid fallback enabled', d => { d.keys.apiKeyAfterQuota = true }], ['changed Profile version', d => { d.management.profiles[0].version++ }],
  ['hidden Profile instructions', d => { d.management.profiles[0].instructions = 'do other work' }],
  ['unreviewed enabled Profile', d => { d.management.profiles.push({ ...d.management.profiles[0], id: id(99) }) }],
]) test('pre-submit resource gate refuses ' + name, async () => {
  const f = resources(mutate); await assert.rejects(pinResources(f.client, f.scope, f.b))
})
test('a prior observed own Run is reauthorized by exact list identity and Task detail, never inferred from any later ended Run', async () => {
  const f = resources(), proof = await verifyOldRun(f.client, f.scope, f.b)
  assert.equal(proof.runId, f.b.oldRunWitness.runId); assert.equal(proof.requiresExactReadonlyAppRecheck, true)
  assert.ok(!JSON.stringify(proof).includes('never-output-old-prompt'))
  f.data.threads.items[0].id = id(99); await assert.rejects(verifyOldRun(f.client, f.scope, f.b), { code: 'old_run_changed' })
})
const rpcInit = (b, action, args) => ({ method: 'POST', headers: { 'x-mikka-workspace-id': b.workspaceId }, body: JSON.stringify({ version: 1, action, args }) })
test('actual outgoing normal RPC carries the Workspace header and allows exactly one reviewed Task creation', async () => {
  const { b } = binding(), state = newState(), doc = fixtureDocument(b, text, env.GITHUB_SHA); let sent = 0
  state.taskInput = { title: doc.title, content: doc.content, status: 'todo', priority: 'normal' }
  const client = createSessionClient('https://app.aspectlylabs.com', async (url, init) => {
    const prepared = { ...init, headers: { ...init.headers, 'x-mikka-workspace-id': b.workspaceId } }
    assertRequest(url, prepared, b, state); sent++
    const payload = JSON.parse(init.body); assert.deepEqual(Object.keys(payload.args[0]).sort(), ['content', 'priority', 'status', 'title'])
    return Response.json({ ok: true, result: { issue: { id: id(20) } } })
  })
  assert.equal((await client.rpc('issues.saveIssue', [state.taskInput])).issue.id, id(20))
  await assert.rejects(client.rpc('issues.saveIssue', [state.taskInput])); assert.equal(sent, 1)
})
for (const [name, path, init] of [
  ['configuration write', '/api/rpc', b => rpcInit(b, 'execution-settings.chooseBotModel', [b.botId, b.chatChoiceId])],
  ['Workspace switch', '/api/rpc', b => rpcInit(b, 'workspace.switchWorkspace', [b.workspaceId])],
  ['Task deletion', '/api/rpc', b => rpcInit(b, 'issue-operations.setIssueDeleted', [{ id: id(20), revision: 1 }])],
  ['foreign Task read', '/api/rpc', b => rpcInit(b, 'issues.getIssue', [id(99)])],
  ['arbitrary model prompt', '/api/rpc', b => rpcInit(b, 'coordinator.sendCoordinatorMessage', ['unreviewed'])],
  ['GitHub mutation', '/api/integrations/github', () => ({ method: 'POST', body: '{}' })],
  ['foreign Factory cancel', '/api/factory/tasks/' + id(99), () => ({ method: 'POST', body: '{}' })],
]) test('transport rejects ' + name, () => {
  const { b } = binding(); assert.throws(() => assertRequest('https://app.aspectlylabs.com/mikka' + path, init(b), b, newState()), { code: 'request_refused' })
})
test('exact dispatch observes its own tool call and normal one-Run result without accepting a different replay', async () => {
  const { b } = binding(), state = newState(), record = { issueId: id(20), submissionId: id(22) }; state.issueId = record.issueId
  let posts = 0
  const client = { rpc: async action => { if (action === 'coordinator.sendCoordinatorMessage') { posts++; return {} }
    assert.equal(action, 'agents.pollIssueThreads'); return { threads: [{ id: id(21), ownedByCurrentUser: true }] } },
  request: async () => new Response([
    { type: 'tool', name: 'dispatch_run', state: 'running', call: 'other', input: JSON.stringify({ issueId: record.issueId }), quote: '[1782:' + id(99) + '] old' },
    { type: 'tool', name: 'dispatch_run', state: 'done', call: 'other', output: JSON.stringify({ runId: id(99) }) },
    { type: 'tool', name: 'dispatch_run', state: 'running', call: 'ours', input: JSON.stringify({ issueId: record.issueId }), quote: '[1782:' + record.submissionId + '] exact fixture' },
    { type: 'tool', name: 'dispatch_run', state: 'done', call: 'ours', output: JSON.stringify({ runId: id(21) }) },
  ].map(v => JSON.stringify(v)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } }) }
  await dispatch(client, record, b, state, 1000); assert.equal(posts, 1); assert.equal(record.runId, id(21)); assert.equal(record.dispatchSettled, true)
})
test('parent, actual actor and exact workflow fence reject another push before any paid work', () => {
  const { b } = binding(), event = { repository: { id: 1427517699, owner: { id: 183887963 } }, ref: env.GITHUB_REF,
    before: b.opsParentSha, after: env.GITHUB_SHA, forced: false, deleted: false }
  guardContext(env, event, env.GITHUB_SHA, [b.opsParentSha], false, b)
  for (const patch of [{ GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_TRIGGERING_ACTOR: 'other' }, { GITHUB_WORKFLOW_REF: 'other' }])
    assert.throws(() => guardContext({ ...env, ...patch }, event, env.GITHUB_SHA, [b.opsParentSha], false, b))
  assert.throws(() => guardContext(env, { ...event, before: env.GITHUB_SHA }, env.GITHUB_SHA, [env.GITHUB_SHA], false, b))
})
function sourceFixture(change = () => {}) {
  const f = binding(); f.main = f.b.applicationSha; f.live = false; f.preflightSuccess = true; change(f)
  return { ...f, fetchImpl: async url => {
    if (url.includes('/api/version')) return Response.json({ build: f.main })
    if (url.endsWith('/git/ref/heads/main')) return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: f.main } })
    if (url.endsWith('/issues/1752')) return Response.json({ number: 1752, comments: 8 })
    if (url.includes('/comments?')) return Response.json([f.comment])
    if (url.includes('/actions/runs/')) return Response.json({ head_sha: f.b.preflightOpsSource, event: 'push', run_attempt: 1,
      path: '.github/workflows/issue1782-publication-preflight.yml', status: 'completed', conclusion: f.preflightSuccess ? 'success' : 'failure', repository: { full_name: 'alexj11324/Mikka' } })
    return Response.json({ total_count: f.live ? 1 : 0, workflow_runs: f.live ? [{}] : [] })
  } }
}
test('actual current source, successful own preflight, latest recorded window and all runtime queues are checked', async () => {
  const f = sourceFixture(); assert.equal((await guardMain(env, f.b, f.fetchImpl, () => at, 25 * 60000)).officialRuntimeIdle, true)
})
for (const [name, mutate] of [['main drift', f => { f.main = '8'.repeat(40) }], ['window replaced', f => { f.comment.id++ }],
  ['window released', f => { f.comment.body += ' released' }], ['runtime active', f => { f.live = true }],
  ['failed preflight', f => { f.preflightSuccess = false }]]) test('source gate refuses ' + name, async () => {
  const f = sourceFixture(mutate); await assert.rejects(guardMain(env, f.b, f.fetchImpl, () => at))
})
test('window expiry during source reads is rechecked, not accepted from an old timestamp', async () => {
  const f = sourceFixture(); let reads = 0
  await assert.rejects(guardMain(env, f.b, f.fetchImpl, () => ++reads === 1 ? at : Date.parse(f.b.windowExpiresAt)), { code: 'window_expired' })
})
test('candidate receipt comes only from this exact own request epoch, Run, repository and normal server publication', () => {
  const f = factoryFixture(); validateFactory(f.snapshot, f.scope, f.record, f.b)
  const receipt = publicationReceipt(f.snapshot, f.flow, f.record)
  assert.equal(receipt.commitSha, '7'.repeat(40)); assert.equal(receipt.independentGithubVerificationRequired, true)
  assert.equal(receipt.exactReadonlyAppPublishedRowRequired, true)
  f.snapshot.task.sourceEventId = id(99); assert.throws(() => validateFactory(f.snapshot, f.scope, f.record, f.b))
})
for (const [name, change] of [['other creator', f => { f.snapshot.task.userId = 'other' }], ['other tenant', f => { f.snapshot.task.workspaceId = id(99) }],
  ['foreign epoch attempt', f => { f.snapshot.attempts[0].output.requestEpoch = id(99) }]]) test('Factory cleanup authority refuses ' + name, () => {
  const f = factoryFixture(); change(f); assert.throws(() => validateFactory(f.snapshot, f.scope, f.record, f.b), { code: 'run_scope_changed' })
})
for (const [name, change] of [['foreign repository', f => { f.snapshot.candidates[0].repository = 'https://github.com/other/project.git' }],
  ['unbound PR', f => { f.flow.issueId = id(99) }], ['non-open PR', f => { f.flow.pullRequest.state = 'closed' }],
  ['changed kind', f => { f.snapshot.candidates[0].kind = 'report' }]]) test('publication observation refuses ' + name, () => {
  const f = factoryFixture(); change(f); assert.throws(() => publicationReceipt(f.snapshot, f.flow, f.record), { code: 'publication_invalid' })
})
for (const ack of [true, false]) test('owned compute cleanup requires real end acknowledgement and readback: ' + ack, async () => {
  const f = factoryFixture(), state = newState(), calls = []
  state.issueId = f.record.issueId; state.factoryId = f.snapshot.task.id; state.runIds.add(f.record.runId)
  validateFactory(f.snapshot, f.scope, f.record, f.b)
  const client = { rpc: async (action, args) => { calls.push(action)
    if (action === 'coordinator.stopCoordinatorTurn') return {}
    if (action === 'coordinator.pollCoordinatorChat') return { botId: f.b.botId, working: false, streamRunId: null }
    if (action === 'agents.getIssueThread') { assert.equal(args[1], f.record.runId); return { thread: { id: f.record.runId, ownedByCurrentUser: true } } }
    if (action === 'agents.getThreadMachine') return { kind: 'cloud', state: 'ended', cloud: null }
    assert.fail(action)
  }, json: async (path, init) => { calls.push(path)
    if (path.endsWith('/machine')) return { runId: f.record.runId, state: ack ? 'ended' : 'error' }
    if (init) { assert.equal(JSON.parse(init.body).action, 'cancel'); return { task: { id: f.snapshot.task.id, status: 'cancelled' } } }
    return f.snapshot
  } }
  const result = await cleanup(client, f.scope, f.record, f.b, state)
  assert.equal(result.status, ack ? 'passed' : 'failed'); assert.equal(result.machines.length, ack ? 1 : 0)
  assert.equal(result.tasksRetained, true); assert.ok(calls.every(c => !c.includes('setIssueDeleted')))
})
test('failure and workflow output remain closed; credentials and provider errors cannot be copied', async () => {
  assert.deepEqual(publicFailure(Error('secret://private-token-body')), { code: 'fixture_failed' })
  const yml = await readFile(new URL('../../.github/workflows/issue1782-publication-fixture.yml', import.meta.url), 'utf8')
  assert.equal((yml.match(/secret-name:/g) ?? []).length, 2)
  assert.doesNotMatch(yml, /MIKKA_DATABASE_URL|DATABASE_URL|VERCEL_TEAM_TOKEN|E2B_API_KEY|contents: write|actions: write/)
  assert.ok(yml.indexOf('node --test') < yml.indexOf('uses: Infisical/'))
})
