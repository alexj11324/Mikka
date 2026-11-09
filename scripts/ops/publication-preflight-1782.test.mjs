import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createSessionClient } from '../acceptance/cloud-startup.mjs'
import { BINDING, assertReadRequest, authorize, capture, checkBinding, executePreflight, guardContext, guardMain,
  inventory, publicFailure, sharedClaudeChoice, windowRecord } from './publication-preflight-1782.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const hash = value => createHash('sha256').update(value).digest('hex')
const reader = 'synthetic-smoke-reader', admin = 'synthetic-policy-admin'
const now = Date.parse('2026-11-09T18:00:00.000Z')
const fixture = () => {
  const binding = { applicationSha: 'a'.repeat(40), opsParentSha: 'd'.repeat(40), workspaceId: id(90), readerSha256: hash(reader), policyAdminSha256: hash(admin),
    ownedBotIds: [id(91)], windowCommentId: 1234, windowCommentBodySha256: 'c'.repeat(64),
    windowStartsAt: '2026-11-09T17:59:00.000Z', windowExpiresAt: '2026-11-09T18:10:00.000Z' }
  const comment = { id: 1234, issue_url: 'https://api.github.com/repos/alexj11324/Mikka/issues/1752',
    user: { login: 'alexj11324', id: 183887963 }, body: '<!-- mikka-1782-publication-preflight:v1\n' + JSON.stringify(windowRecord(binding)) + '\n-->' }
  binding.windowCommentBodySha256 = hash(comment.body)
  return { binding, comment }
}
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/ops/self-hosted-vault-closeout-20261108', GITHUB_ACTOR: 'alexj11324', GITHUB_TRIGGERING_ACTOR: 'alexj11324',
  GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '5678', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'publication_preflight',
  GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/issue1782-publication-preflight.yml@refs/heads/ops/self-hosted-vault-closeout-20261108',
  GITHUB_TOKEN: 'synthetic-github-credential', SMOKE_OWNER_EMAIL: 'reader+mikka-smoke@example.invalid', SMOKE_OWNER_PASSWORD: 'never-emit-password' }
const event = { repository: { id: 1427517699, owner: { id: 183887963 } }, ref: env.GITHUB_REF,
  before: 'd'.repeat(40), after: env.GITHUB_SHA, forced: false, deleted: false }

function githubFixture(mutate = () => {}) {
  const f = fixture(), calls = []
  f.main = { ref: 'refs/heads/main', object: { type: 'commit', sha: f.binding.applicationSha } }
  f.version = { build: f.binding.applicationSha }; f.runs = { total_count: 0, workflow_runs: [] }
  mutate(f)
  return { ...f, calls, fetchImpl: async (url, init) => {
    calls.push({ url, init }); const u = new URL(url)
    assert.equal(init.redirect, 'error')
    if (u.hostname === 'app.aspectlylabs.com') {
      assert.equal(new Headers(init.headers).has('authorization'), false)
      return Response.json(f.version)
    }
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + env.GITHUB_TOKEN)
    if (u.pathname.endsWith('/git/ref/heads/main')) return Response.json(f.main)
    if (u.pathname.endsWith('/issues/1752')) return Response.json({ number: 1752, comments: 10 })
    if (u.pathname.endsWith('/issues/1752/comments')) return Response.json([f.comment])
    if (u.pathname.endsWith('/e2b-official-runtime.yml/runs')) return Response.json(f.runs)
    assert.fail('unexpected GitHub read')
  } }
}

function ordinaryFixture(change = () => {}) {
  const { binding } = fixture(), calls = []
  const source = { kind: 'subscription', connectionId: id(92) }
  const data = {
    binding, signedOut: 0, sessionReads: 0,
    session: { user: { id: reader, email: env.SMOKE_OWNER_EMAIL } },
    workspace: { currentUserId: reader, workspace: { id: id(90), kind: 'team' }, role: 'member',
      choices: [{ id: id(90), kind: 'team' }], members: [{ userId: reader, name: 'Synthetic Reader', role: 'member', status: 'active' }, { userId: admin, name: 'Synthetic Admin', role: 'admin', status: 'active' }] },
    github: { viewerId: reader, connected: true, installed: true, repositories: [{ fullName: 'alexj11324/Mikka-handoff' }] },
    verification: { viewerId: reader, repository: 'alexj11324/Mikka-handoff', verifyCommand: 'never-emit-verify-command' },
    management: { profiles: [{ id: id(93), version: 1, digest: 'd'.repeat(64), enabled: true, archivedAt: null, harness: 'codex',
      model: { mode: 'fixed', harness: 'codex', model: 'gpt-6-luna', source }, instructions: '', skills: [] }],
      availability: { [id(93)]: { available: true } }, catalog: { models: [{ harness: 'codex', model: 'gpt-6-luna', source, available: true }] } },
    order: { location: 'cloud', cloudReady: true, candidates: [{ harness: 'codex', model: 'gpt-6-luna', source, credentialOwnerId: admin }] },
    bots: { items: [{ id: id(91), name: 'never-emit-bot-name' }], live: { ownerId: reader, workspaceId: id(90) } },
    chat: { botId: id(91), enabled: true, working: false, streamRunId: null, items: [{ text: 'never-emit-chat' }] },
    menu: { groups: [], current: { kind: 'subscription', chosen: true, available: true, provider: 'codex', modelId: 'gpt-6-luna' } },
    keys: { apiKeyAfterQuota: false, keys: [] },
    threads: { items: [{ id: id(101), issueId: id(1), createdAt: '2026-11-08T18:00:00.000Z', status: 'succeeded', prompt: 'never-emit-prompt', lastReply: 'never-emit-reply' }] },
    deleted: false, issueOwner: reader, issueWorkspace: id(90), deletedAt: '2026-11-09T17:00:00.000Z',
  }
  change(data)
  const fetchImpl = async (url, init) => {
    init = { ...init, headers: { ...init.headers, 'x-mikka-workspace-id': binding.workspaceId } }
    assertReadRequest(url, init, binding); const p = url.pathname.replace('/mikka', '')
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path: p, action: body?.action, method: init.method ?? 'GET' })
    if (p === '/api/auth/sign-in/email') return Response.json({ ok: true })
    if (p === '/api/auth/sign-out') { data.signedOut++; return Response.json({}, { status: data.failSignout ? 500 : 200 }) }
    if (p === '/api/auth/get-session') { data.sessionReads++; return Response.json(data.sessionAfter && data.sessionReads > 1 ? data.sessionAfter : data.session) }
    if (p === '/api/workspace') return Response.json(data.workspace)
    if (p === '/api/integrations/github') return Response.json(data.github)
    if (p === '/api/integrations/github/repositories/verification') return Response.json(data.verification)
    if (p === '/api/factory/agent-profiles') return Response.json(data.management)
    if (p === '/api/settings/api-keys') return Response.json(data.keys)
    if (p === '/api/bots/' + id(91)) return Response.json({ id: id(91), name: 'never-emit-bot-name' })
    assert.equal(p, '/api/rpc')
    const values = { 'bots.pollBots': data.bots, 'model-order.getModelOrder': data.order,
      'coordinator.pollCoordinatorChat': data.chat, 'execution-settings.getBotModelMenu': data.menu, 'task-runs.pollThreads': data.threads }
    let result = values[body.action]
    if (body.action === 'issues.getIssue') result = data.deleted ? { error: 'issueNotFound', params: { $mikka: 'undefined' } }
      : { issue: { id: body.args[0], userId: data.issueOwner, workspaceId: data.issueWorkspace, ownershipState: 'bound', scope: 'personal', title: 'never-emit-title' } }
    if (body.action === 'issue-operations.getDeletedIssue') result = data.deletedDenied ? null
      : { id: body.args[0], deletedAt: data.deletedAt, title: 'never-emit-deleted-title' }
    assert.notEqual(result, undefined, 'unregistered fixture action ' + body.action)
    return Response.json({ ok: true, result })
  }
  const client = createSessionClient('https://app.aspectlylabs.com', fetchImpl)
  return { client, data, binding, calls, fetchImpl }
}

function liveWindow(f, expiresAt = Date.now() + 10 * 60000) {
  f.binding.windowStartsAt = new Date(Date.now() - 1000).toISOString()
  f.binding.windowExpiresAt = new Date(expiresAt).toISOString()
  f.comment.body = '<!-- mikka-1782-publication-preflight:v1\n' + JSON.stringify(windowRecord(f.binding)) + '\n-->'
  f.binding.windowCommentBodySha256 = hash(f.comment.body)
  return f
}
function executionFixture() {
  const ordinary = ordinaryFixture(), github = liveWindow(githubFixture())
  Object.assign(ordinary.binding, github.binding)
  const fetchImpl = (url, init) => {
    const parsed = new URL(url)
    return parsed.hostname === 'api.github.com' || parsed.pathname === '/mikka/api/version'
      ? github.fetchImpl(String(url), init) : ordinary.fetchImpl(parsed, init)
  }
  return { ordinary, github, fetchImpl, binding: ordinary.binding }
}

test('default entry is unbound and disabled; activation still requires the complete checked binding', async () => {
  const text = await readFile(new URL('../../.github/workflows/issue1782-publication-preflight.yml', import.meta.url), 'utf8')
  if (Object.values(BINDING).some(value => value === null)) {
    assert.ok(Object.values(BINDING).every(value => value === null))
    assert.throws(() => checkBinding(), error => error.code === 'binding_refused'); assert.match(text, /    if: false\n/)
  } else checkBinding()
  assert.ok(checkBinding(fixture().binding))
})
for (const [name, patch] of [['missing source', { applicationSha: null }], ['missing exact Ops parent', { opsParentSha: null }], ['foreign workspace shape', { workspaceId: 'other' }],
  ['duplicate Bot', { ownedBotIds: [id(91), id(91)] }], ['missing reader', { readerSha256: null }],
  ['unbounded window', { windowExpiresAt: '2026-11-09T19:00:00.000Z' }]]) test('binding rejects ' + name, () => {
  assert.throws(() => checkBinding({ ...fixture().binding, ...patch }), error => error.code === 'binding_refused')
})
test('source context accepts only the owned exact new workflow and actual push identity', () => {
  const { binding } = fixture(), parents = [binding.opsParentSha]
  guardContext(env, event, env.GITHUB_SHA, false, parents, binding)
  for (const change of [{ GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_JOB: 'domain_history_before' },
    { GITHUB_TRIGGERING_ACTOR: 'someone-else' }, { GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('issue1782-publication-preflight', 'issue1782-domain-history-before') }]) {
    assert.throws(() => guardContext({ ...env, ...change }, event, env.GITHUB_SHA, false, parents, binding))
  }
  for (const change of [{ forced: true }, { deleted: true }, { after: 'e'.repeat(40) }, { repository: { id: 1, owner: { id: 183887963 } } }]) {
    assert.throws(() => guardContext(env, { ...event, ...change }, env.GITHUB_SHA, false, parents, binding))
  }
  assert.throws(() => guardContext(env, event, 'e'.repeat(40), false, parents, binding))
  assert.throws(() => guardContext(env, event, env.GITHUB_SHA, true, parents, binding))
})
test('a successor push cannot reuse the still-live preflight account grant', () => {
  const { binding } = fixture()
  guardContext(env, event, env.GITHUB_SHA, false, [binding.opsParentSha], binding)
  const successor = { ...env, GITHUB_SHA: 'e'.repeat(40), GITHUB_RUN_ID: '5679' }
  const laterEvent = { ...event, before: env.GITHUB_SHA, after: successor.GITHUB_SHA }
  assert.throws(() => guardContext(successor, laterEvent, successor.GITHUB_SHA, false, [env.GITHUB_SHA], binding), { code: 'source_refused' })
})
test('the recorded push predecessor and the actual sole Git parent must both match', () => {
  const { binding } = fixture()
  for (const [before, parents] of [[undefined, [binding.opsParentSha]], ['e'.repeat(40), [binding.opsParentSha]],
    [binding.opsParentSha, undefined], [binding.opsParentSha, []], [binding.opsParentSha, ['e'.repeat(40)]],
    [binding.opsParentSha, [binding.opsParentSha, 'e'.repeat(40)]]]) {
    assert.throws(() => guardContext(env, { ...event, before }, env.GITHUB_SHA, false, parents, binding), { code: 'source_refused' })
  }
})
test('actual main, served source, latest own window and every official runtime live status are read before credentials', async () => {
  const f = githubFixture(), result = await guardMain(env, f.binding, f.fetchImpl, now, 180000)
  assert.equal(result.officialRuntimeIdle, true); assert.equal(result.mainSha, f.binding.applicationSha)
  assert.deepEqual(f.calls.filter(call => call.url.includes('/e2b-official-runtime.yml/runs')).map(call => new URL(call.url).searchParams.get('status')),
    ['queued', 'in_progress', 'waiting', 'pending', 'requested'])
})
for (const [name, mutate, code] of [
  ['main drift', f => { f.main.object.sha = 'e'.repeat(40) }, 'main_changed'],
  ['served drift', f => { f.version.build = 'e'.repeat(40) }, 'build_changed'],
  ['new window comment', f => { f.comment.id++ }, 'window_changed'],
  ['foreign window owner', f => { f.comment.user.id++ }, 'window_changed'],
  ['changed window body', f => { f.comment.body += 'released' }, 'window_changed'],
  ['runtime publisher active', f => { f.runs = { total_count: 1, workflow_runs: [{ id: 99 }] } }, 'runtime_active'],
  ['invented window expiry', f => { f.binding.windowExpiresAt = '2026-11-09T18:11:00.000Z' }, 'window_changed'],
  ['parent changed without a new owner window', f => { f.binding.opsParentSha = 'e'.repeat(40) }, 'window_changed'],
]) test('precredential guard refuses ' + name, async () => {
  const f = githubFixture(mutate); await assert.rejects(guardMain(env, f.binding, f.fetchImpl, now), error => error.code === code)
})
test('an expired or nearly expired window refuses before any network request', async () => {
  const f = githubFixture()
  await assert.rejects(guardMain(env, f.binding, f.fetchImpl, now + 11 * 60000), error => error.code === 'window_expired')
  await assert.rejects(guardMain(env, f.binding, f.fetchImpl, now + 8 * 60000, 180000), error => error.code === 'window_expired')
  assert.equal(f.calls.length, 0)
})
test('the default live clock refuses a window that expires during real source reads', async () => {
  const f = liveWindow(githubFixture(), Date.now() + 60)
  let reads = 0
  const delayed = async (url, init) => { if (reads++ === 0) await delay(100); return f.fetchImpl(url, init) }
  await assert.rejects(guardMain(env, f.binding, delayed), { code: 'window_expired' })
  assert.ok(reads > 0, 'the rejection must follow an actual delayed read')
})
test('minimum remaining window is rechecked with the live clock after a source response', async () => {
  const f = liveWindow(githubFixture(), Date.now() + 180)
  let reads = 0
  const delayed = async (url, init) => { if (reads++ === 0) await delay(90); return f.fetchImpl(url, init) }
  await assert.rejects(guardMain(env, f.binding, delayed, Date.now, 120), { code: 'window_expired' })
  assert.ok(reads > 0)
})
test('the shared execution work budget starts at the first guard and aborts its stalled JSON body before sign-in', async () => {
  const f = executionFixture(); let cancelled = 0, requestSignal
  const started = performance.now()
  await assert.rejects(executePreflight('capture', env, f.binding, { workMs: 80, signoutMs: 60,
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"ref":')) }, cancel() { cancelled++ } }))
    } }), { code: 'budget_exhausted' })
  assert.ok(performance.now() - started >= 50)
  assert.equal(requestSignal.aborted, true); assert.equal(cancelled, 1)
  assert.equal(f.ordinary.calls.length, 0)
})
test('a post-login after-pin uses the same work deadline and leaves an independent real signout allowance', async () => {
  const f = executionFixture(); let mainReads = 0, firstSourceAt, stalledCancelled = 0, signoutSignal
  const report = await executePreflight('capture', env, f.binding, { workMs: 180, signoutMs: 80,
    fetchImpl: async (url, init) => {
      const p = new URL(url).pathname
      if (p.endsWith('/git/ref/heads/main')) {
        mainReads++
        if (mainReads === 1) { firstSourceAt = Date.now(); await delay(60) }
        if (mainReads === 3) return new Response(new ReadableStream({ cancel() { stalledCancelled++ } }))
      }
      if (p === '/mikka/api/auth/sign-out') { signoutSignal = init.signal; assert.equal(signoutSignal.aborted, false); await delay(10) }
      return f.fetchImpl(url, init)
    } })
  assert.equal(mainReads, 3); assert.equal(report.phase, 'source_after'); assert.equal(report.status, 'failed')
  assert.equal(report.failure.code, 'budget_exhausted'); assert.equal(report.cleanup.signedOut, true)
  assert.equal(stalledCancelled, 1); assert.ok(signoutSignal)
  assert.equal(f.ordinary.data.signedOut, 1)
  assert.equal(report.executionBudget.workMs, 180); assert.equal(report.executionBudget.signoutMs, 80)
  assert.ok(Date.parse(report.executionBudget.startedAt) <= firstSourceAt)
  assert.equal(Date.parse(report.executionBudget.workDeadline) - Date.parse(report.executionBudget.startedAt), 180)
  assert.equal(report.executionBudget.timersClosed, true)
})
test('the actual bounded entry completes all three source pins and ordinary reads without changing the configuration', async () => {
  const f = executionFixture(), report = await executePreflight('capture', env, f.binding, { fetchImpl: f.fetchImpl, workMs: 1000, signoutMs: 100 })
  assert.equal(report.status, 'preflight_ready'); assert.equal(report.cleanup.signedOut, true)
  assert.equal(f.github.calls.filter(c => c.url.endsWith('/git/ref/heads/main')).length, 3)
  assert.equal(report.executionBudget.timersClosed, true)
  assert.equal(f.ordinary.calls.some(c => c.action === 'issues.saveIssue' || c.action === 'coordinator.sendCoordinatorMessage'), false)
})
test('an after-pin source failure remains primary when the separate signout acknowledgement fails', async () => {
  const f = executionFixture(); f.ordinary.data.failSignout = true; let mainReads = 0
  const report = await executePreflight('capture', env, f.binding, { workMs: 1000, signoutMs: 100,
    fetchImpl: (url, init) => {
      if (new URL(url).pathname.endsWith('/git/ref/heads/main') && ++mainReads === 3)
        return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: 'e'.repeat(40) } })
      return f.fetchImpl(url, init)
    } })
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'main_changed')
  assert.equal(report.cleanup.signedOut, false); assert.equal(report.executionBudget.timersClosed, true)
})
test('transport refuses all model, Task, settings, Workspace and arbitrary target writes', () => {
  const { binding } = fixture(), url = 'https://app.aspectlylabs.com/mikka/api/rpc'
  for (const action of ['coordinator.sendCoordinatorMessage', 'issues.saveIssue', 'workspace.switchWorkspace',
    'execution-settings.chooseBotModel', 'coordinator.getCoordinatorChat', 'agents.stopRun']) {
    assert.throws(() => assertReadRequest(url, { method: 'POST', body: JSON.stringify({ version: 1, action, args: [] }) }, binding), error => error.code === 'read_only_refused')
  }
  assert.throws(() => assertReadRequest('https://foreign.invalid/mikka/api/workspace', {}, binding))
  assert.throws(() => assertReadRequest('https://app.aspectlylabs.com/mikka/api/workspace?workspace=' + id(99), {}, binding))
  assert.throws(() => assertReadRequest('https://app.aspectlylabs.com/mikka/api/factory/agent-profiles', { method: 'POST', body: '{}' }, binding))
  assert.throws(() => assertReadRequest('https://app.aspectlylabs.com/mikka/api/bots/' + id(999), {}, binding))
  assert.throws(() => assertReadRequest(url, { method: 'POST', body: JSON.stringify({ version: 1, action: 'bots.pollBots', args: [] }) }, binding))
})
test('ordinary registered read RPC transport reports configuration and freezes real old references without leaking content', async () => {
  const f = ordinaryFixture(), report = await capture(f.client, env, f.binding, async () => ({ mainSha: f.binding.applicationSha }), () => now)
  assert.equal(report.status, 'preflight_ready'); assert.equal(report.cleanup.signedOut, true); assert.equal(f.data.signedOut, 1)
  assert.equal(report.opsParentSha, f.binding.opsParentSha)
  assert.equal(report.inventory.repository.githubWriteCapability, 'requires_real_run_push_and_server_pr')
  assert.deepEqual(report.inventory.oldRunCandidates.map(row => [row.taskId, row.runId, row.observedStatus]), [[id(1), id(101), 'succeeded']])
  assert.equal(report.inventory.profiles[0].connectionId, id(92))
  assert.equal(f.calls.some(call => call.action === 'coordinator.getCoordinatorChat'), false)
  const text = JSON.stringify(report)
  for (const privateValue of [env.SMOKE_OWNER_EMAIL, env.SMOKE_OWNER_PASSWORD, reader, admin, 'never-emit-chat', 'never-emit-prompt',
    'never-emit-reply', 'never-emit-title', 'never-emit-bot-name', 'never-emit-verify-command']) assert.ok(!text.includes(privateValue))
})
for (const [name, mutate, code] of [
  ['changed reader', d => { d.session.user.id = 'wrong-reader' }, 'account_refused'],
  ['wrong tenant', d => { d.workspace.workspace.id = id(99) }, 'workspace_refused'],
  ['suspended membership', d => { d.workspace.members[0].status = 'suspended' }, 'workspace_refused'],
  ['changed policy admin', d => { d.workspace.members[1].userId = 'different-admin' }, 'workspace_refused'],
]) test('ordinary authorization rejects ' + name + ' and signs out', async () => {
  const f = ordinaryFixture(mutate), report = await capture(f.client, env, f.binding, async () => ({}), () => now)
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, code); assert.equal(report.cleanup.signedOut, true)
  assert.equal(f.calls.some(call => call.path === '/api/integrations/github'), false)
})
for (const [name, mutate, blocker] of [
  ['unavailable repository', d => { d.github.repositories = [] }, 'repository_not_available'],
  ['no approved shared source', d => { d.order.candidates[0].credentialOwnerId = 'different-admin' }, 'approved_shared_subscription_missing'],
  ['readonly Profile instructions', d => { d.management.profiles[0].instructions = 'Read only; do not write.' }, 'writable_profile_requires_review_or_creation'],
  ['unbounded review Profile', d => { d.management.profiles[0].model = { mode: 'inherit' } }, 'automatic_review_source_unbounded'],
  ['busy owned Bot', d => { d.chat.working = true }, 'owned_idle_official_bot_missing'],
  ['paid chat fallback', d => { d.keys = { apiKeyAfterQuota: true, keys: [{ provider: 'openai', protocol: 'openai', models: ['gpt-6-luna'] }] } }, 'approved_chat_api_key_fallback_reachable'],
  ['cloud unavailable', d => { d.order.cloudReady = false }, 'cloud_not_ready'],
  ['saved local preference does not prove an unavailable cloud', d => { d.order.location = 'local'; d.order.cloudReady = false }, 'explicit_cloud_readiness_unproven'],
  ['no old Run', d => { d.threads.items = [] }, 'authorized_old_run_missing'],
]) test('resource preflight exposes ' + name + ' without submitting or changing settings', async () => {
  const f = ordinaryFixture(mutate), report = await capture(f.client, env, f.binding, async () => ({}), () => now)
  assert.equal(report.status, 'preflight_blocked'); assert.ok(report.inventory.blockers.includes(blocker))
  assert.equal(report.cleanup.signedOut, true)
  assert.ok(f.calls.every(call => call.method === 'GET' || call.path === '/api/rpc' || call.path.startsWith('/api/auth/')))
})
test('normal exact owner-deleted API proof can nominate old history without restoring or modifying it', async () => {
  const f = ordinaryFixture(d => { d.deleted = true }), report = await capture(f.client, env, f.binding, async () => ({}), () => now)
  assert.equal(report.status, 'preflight_ready'); assert.equal(report.inventory.oldRunCandidates[0].accessMode, 'owned_deleted')
  assert.equal(report.inventory.oldRunCandidates[0].creatorSha256, hash(reader))
  assert.equal(report.inventory.oldRunCandidates[0].deletedAtSha256, hash(f.data.deletedAt))
  assert.ok(!JSON.stringify(report).includes(f.data.deletedAt))
})
test('missing or foreign Task permission cannot be replaced with a Run-list reference', async () => {
  for (const mutate of [d => { d.issueWorkspace = id(99) }, d => { d.deleted = true; d.deletedDenied = true }]) {
    const f = ordinaryFixture(mutate), report = await capture(f.client, env, f.binding, async () => ({}), () => now)
    assert.equal(report.status, 'failed'); assert.equal(report.cleanup.signedOut, true)
  }
})
test('old references are bounded to three different authorized Tasks and do not use active or unbound Run references', async () => {
  const f = ordinaryFixture(d => { d.threads.items = Array.from({ length: 10 }, (_, n) => ({ id: id(101 + n),
    issueId: n === 0 ? null : id(n), createdAt: '2026-11-08T18:00:00.000Z', status: n === 1 ? 'running' : 'succeeded' })) })
  const scope = await authorize(f.client, env.SMOKE_OWNER_EMAIL, f.binding)
  const result = await inventory(f.client, scope, f.binding, now)
  assert.equal(result.oldRunCandidates.length, 3); assert.deepEqual(result.oldRunCandidates.map(row => row.taskId), [id(2), id(3), id(4)])
})
test('changed session after reads and failed real signout cannot produce a successful preflight', async () => {
  const changed = ordinaryFixture(d => { d.sessionAfter = { user: { id: 'different-user', email: env.SMOKE_OWNER_EMAIL } } })
  const a = await capture(changed.client, env, changed.binding, async () => ({}), () => now)
  assert.equal(a.status, 'failed'); assert.equal(a.cleanup.signedOut, true)
  const cleanup = ordinaryFixture(d => { d.failSignout = true })
  const b = await capture(cleanup.client, env, cleanup.binding, async () => ({}), () => now)
  assert.equal(b.status, 'failed'); assert.equal(b.cleanup.signedOut, false); assert.equal(b.failure.code, 'signout_failed')
})
test('source refusal occurs before sign-in and private failure messages are never copied', async () => {
  const f = ordinaryFixture(), report = await capture(f.client, env, f.binding, async () => { throw Object.assign(Error('secret'), { code: 'main_changed' }) }, () => now)
  assert.equal(report.failure.code, 'main_changed'); assert.equal(f.calls.length, 0)
  assert.deepEqual(publicFailure(Error('postgres://private:credential@host/db')), { code: 'preflight_failed' })
})
test('workflow has only existing exact SMOKE reads, least read scopes and the shared queue', async () => {
  const text = await readFile(new URL('../../.github/workflows/issue1782-publication-preflight.yml', import.meta.url), 'utf8')
  assert.deepEqual([...text.matchAll(/secret-name: (\S+)/g)].map(row => row[1]), ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD'])
  assert.equal((text.match(/identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac/g) ?? []).length, 2)
  assert.match(text, /group: production-smoke-owner-acceptance/); assert.match(text, /cancel-in-progress: false/)
  assert.match(text, /actions: read/); assert.match(text, /issues: read/)
  assert.match(text, /fetch-depth: 2/)
  assert.doesNotMatch(text, /contents: write|actions: write|issues: write|continue-on-error|MIKKA_DATABASE_URL|DATABASE_URL/)
  assert.ok(text.indexOf('node --test scripts/ops/publication-preflight-1782.test.mjs') < text.indexOf('uses: Infisical/secrets-action'))
  assert.ok(text.indexOf('publication-preflight-1782.mjs check') < text.indexOf('uses: Infisical/secrets-action'))
})

function withSharedClaude(data) {
  data.order.candidates.push({ harness: 'claude_code', model: 'claude-haiku-5-5',
    source: { kind: 'subscription', connectionId: id(96) }, credentialOwnerId: admin })
  data.menu.groups = [{ kind: 'subscription', provider: 'claude', owner: 'Synthetic Admin',
    credentialLabel: 'never-emit-source-label', options: [{ id: id(97), provider: 'claude', modelId: 'claude-haiku-5-5' }] }]
}
test('normal Coordinator menu inventory records the real choice and separate order observation without a selection', async () => {
  const f = ordinaryFixture(data => { withSharedClaude(data); data.binding.ownedBotIds = [] })
  const report = await capture(f.client, env, f.binding, async () => ({}), () => now)
  assert.equal(report.status, 'preflight_blocked', 'missing owned Bot remains an honest setup prerequisite')
  assert.ok(report.inventory.claudeChatChoice, 'the ordinary menu must yield a source-bound choice observation')
  const choice = report.inventory.claudeChatChoice
  assert.equal(choice.status, 'correlated_unique_directories')
  assert.deepEqual(choice.counts, { orderCandidates: 1, menuOptions: 1, activeMembersWithAdminName: 1 })
  assert.deepEqual(choice.orderObservation, { harness: 'claude_code', model: 'claude-haiku-5-5', kind: 'subscription',
    connectionId: id(96), credentialOwnerSha256: hash(admin) })
  assert.deepEqual(choice.menuObservation, { readTarget: 'workspace_coordinator', choiceId: id(97), provider: 'claude',
    modelId: 'claude-haiku-5-5', kind: 'subscription', sharedOwnerNameSha256: hash('Synthetic Admin') })
  assert.match(choice.limitation, /^menu_does_not_expose_connection_or_owner_ids;/)
  assert.equal(f.calls.filter(call => call.action === 'execution-settings.getBotModelMenu').length, 1)
  assert.equal(f.calls.some(call => call.action === 'execution-settings.chooseBotModel'), false)
  assert.equal(report.cleanup.signedOut, true)
  for (const raw of ['Synthetic Admin', 'never-emit-source-label', admin]) assert.ok(!JSON.stringify(report).includes(raw))
})
test('matching model text cannot prove ambiguous directories, owner names, or a different source', () => {
  const mutations = [
    data => data.order.candidates.push({ ...data.order.candidates[1], source: { kind: 'subscription', connectionId: id(98) } }),
    data => data.menu.groups.push({ ...data.menu.groups[0], options: [{ ...data.menu.groups[0].options[0], id: id(98) }] }),
    data => data.workspace.members.push({ userId: 'another-person', name: 'Synthetic Admin', role: 'member', status: 'active' }),
    data => { data.menu.groups[0].owner = 'Different Display Name' },
    data => { delete data.menu.groups[0].owner },
    data => { data.menu.groups[0].options[0].id = 'apikey:' + id(97) + ':claude-haiku-5-5' },
    data => { data.order.candidates[1].credentialOwnerId = reader },
    data => { data.order.candidates[1].source = { kind: 'api_key', keyId: id(96) } },
  ]
  for (const mutate of mutations) {
    const { data } = ordinaryFixture(d => { withSharedClaude(d); mutate(d) })
    const value = sharedClaudeChoice(data.order, data.menu, data.workspace, { ownerId: reader, adminId: admin, workspaceId: id(90) })
    assert.equal(value.status, 'unproven'); assert.equal(value.menuObservation, undefined)
    assert.equal(value.orderObservation, undefined)
  }
})
test('a missing Claude directory remains unavailable and does not fabricate a choice UUID', () => {
  const { data } = ordinaryFixture()
  const value = sharedClaudeChoice(data.order, data.menu, data.workspace, { ownerId: reader, adminId: admin, workspaceId: id(90) })
  assert.equal(value.status, 'unavailable'); assert.equal(value.menuObservation, undefined)
  assert.equal(value.orderObservation, undefined)
})
test('the additional null-target permission is only the normal menu getter, never choose or arbitrary Bot access', () => {
  const { binding } = fixture(), url = 'https://app.aspectlylabs.com/mikka/api/rpc'
  const request = (action, args) => ({ method: 'POST', headers: { 'x-mikka-workspace-id': binding.workspaceId },
    body: JSON.stringify({ version: 1, action, args }) })
  assert.doesNotThrow(() => assertReadRequest(url, request('execution-settings.getBotModelMenu', [null]), binding))
  for (const [action, args] of [['execution-settings.chooseBotModel', [null, id(97)]],
    ['execution-settings.chooseBotModel', [id(91), id(97)]], ['coordinator.pollCoordinatorChat', [null]],
    ['execution-settings.getBotModelMenu', [id(999)]]])
    assert.throws(() => assertReadRequest(url, request(action, args), binding), error => error.code === 'read_only_refused')
})
test('the menu correlation refuses changed workspace, missing active admin, and malformed menu DTO', () => {
  for (const mutate of [d => { d.workspace.workspace.id = id(999) }, d => { d.workspace.members[1].status = 'suspended' },
    d => { d.menu.groups[0].options = null }]) {
    const { data } = ordinaryFixture(d => { withSharedClaude(d); mutate(d) })
    assert.throws(() => sharedClaudeChoice(data.order, data.menu, data.workspace, { ownerId: reader, adminId: admin, workspaceId: id(90) }),
      error => ['response_invalid', 'workspace_refused'].includes(error.code))
  }
})
