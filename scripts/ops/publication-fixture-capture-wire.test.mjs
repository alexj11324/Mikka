import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { capture, createCaptureBudget, createFixtureClient, fixtureDocument, MODEL,
  newState, windowRecord } from './publication-fixture-1782.mjs'

// Synthetic normal HTTP/RPC responses exercise the complete capture transaction.
// No production session, model, database, GitHub request, or resource is used.
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const hash = value => createHash('sha256').update(value).digest('hex')
const reader = 'synthetic-reader', admin = 'synthetic-admin'
const email = 'fixture+mikka-smoke@example.test', password = 'synthetic-password-never-output'
const cookie = 'synthetic-session-never-output', at = Date.parse('2026-11-09T20:01:00.000Z')
const text = await readFile(new URL('./publication-fixture-1782.md', import.meta.url), 'utf8')
const env = { GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '6789', GITHUB_RUN_ATTEMPT: '1',
  SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: password }
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers } })

function fixture(options = {}) {
  const b = { applicationSha: 'a'.repeat(40), workspaceId: id(1), readerSha256: hash(reader), policyAdminSha256: hash(admin),
    opsParentSha: 'c'.repeat(40), preflightRunId: 1234, preflightOpsSource: 'd'.repeat(40), preflightEvidenceSha256: 'e'.repeat(64),
    botId: id(2), botCreationReceiptSha256: 'f'.repeat(64), chatChoiceId: id(3), subscriptionConnectionId: id(4),
    profileId: id(5), profileVersion: 3, profileDigest: '9'.repeat(64),
    reviewProfilePins: [{ id: id(5), version: 3, digest: '9'.repeat(64), harness: MODEL.harness, model: MODEL.model, connectionId: id(4) }],
    repositoryBaseSha: 'f'.repeat(40), oldRunWitness: { taskId: id(7), runId: id(8), createdAt: '2026-11-08T17:00:00.000Z',
      observedAt: '2026-11-09T19:55:00.000Z', observedStatus: 'succeeded', creatorSha256: hash(reader), accessMode: 'live', deletedAtSha256: null },
    windowCommentId: 3456, windowCommentBodySha256: null,
    windowStartsAt: '2026-11-09T20:00:00.000Z', windowExpiresAt: '2026-11-09T20:44:00.000Z' }
  b.windowCommentBodySha256 = hash('<!-- mikka-1782-publication-fixture:v1\n' + JSON.stringify(windowRecord(b)) + '\n-->')
  const state = newState(), calls = [], machineEnds = [], watched = [], doc = fixtureDocument(b, text, env.GITHUB_SHA)
  const profile = { id: b.profileId, version: b.profileVersion, digest: b.profileDigest, enabled: true, archivedAt: null,
    harness: MODEL.harness, model: { mode: 'fixed', harness: MODEL.harness, model: MODEL.model,
      source: { kind: 'subscription', connectionId: b.subscriptionConnectionId } }, instructions: '', roles: [], skills: [] }
  const identity = { version: 1, requester: reader, executionPrincipal: reader, botOwner: reader, outputOwner: reader,
    botId: b.botId, workspaceId: b.workspaceId, personalResourcePolicy: 'requester_only', resourceBindings: [
      { kind: 'device', id: id(30), ownerId: reader, access: 'owner' },
      { kind: 'subscription', id: id(31), ownerId: admin, access: 'workspace_share', revision: '1' }],
    billingAccount: { model: { kind: 'subscription', ownerId: admin, resourceId: id(31) },
      runtime: { kind: 'e2b', ownerId: reader, resourceId: reader } } }
  const run = runId => ({ id: runId, issueId: id(20), botId: b.botId, status: 'succeeded',
    harness: MODEL.harness, model: MODEL.model, credentialType: 'subscription', subscriptionRoute: 'claude_code_cli',
    agentProfile: { profileId: b.profileId, version: b.profileVersion, digest: b.profileDigest, source: 'explicit' },
    executionIdentity: structuredClone(identity) })
  const runIds = options.secondRun ? [id(21), id(26)] : [id(21)]
  const snapshot = { task: { id: id(23), issueId: id(20), userId: reader, workspaceId: b.workspaceId, botId: b.botId,
    sourceEventId: id(24), revision: 3, candidateId: id(25), status: options.passedStage ? 'passed' : 'pending' },
    attempts: runIds.map((runId, index) => ({ id: id(40 + index), taskId: id(23), runId,
      stage: index === 0 ? 'execute' : 'review', candidateId: id(25), output: { requestEpoch: id(24) } })),
    candidates: [{ id: id(25), taskId: id(23), runId: id(21), kind: 'repository', sha: '7'.repeat(40),
      repository: 'https://github.com/alexj11324/Mikka-handoff.git', scope: 'issue:' + id(20) }] }
  const flow = { version: 2, id: id(23), issueId: id(20), botId: b.botId,
    pullRequest: { url: 'https://github.com/alexj11324/Mikka-handoff/pull/123', state: 'open' } }
  const issue = () => ({ ...structuredClone(state.taskInput ?? {}), id: id(20), userId: reader, workspaceId: b.workspaceId,
    revision: options.invalidTaskRevision ? 0 : 1, identifier: 'SYNTH-1782', createdAt: '2026-11-09T20:01:00.000Z',
    ownershipState: 'bound', scope: 'workspace' })
  let signedIn = false, submitted = false, stopped = false, pins = 0, clears = 0, activityReads = 0
  const budget = createCaptureBudget(b, { now: () => at, totalMs: 60000, cleanupReserveMs: 10000, signoutReserveMs: 1000 })
  const fetchImpl = async (url, init) => {
    assert.equal(url.origin, 'https://app.aspectlylabs.com')
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal instanceof AbortSignal)
    assert.equal(init.signal.aborted, false)
    const path = url.pathname.replace(/^\/mikka/, ''), method = init.method ?? 'GET', headers = new Headers(init.headers)
    assert.equal(headers.get('x-mikka-workspace-id'), b.workspaceId)
    assert.equal(headers.get('origin'), 'https://app.aspectlylabs.com')
    const body = method === 'POST' ? JSON.parse(init.body) : null
    calls.push({ path, method, action: body?.action, phase: budget.phase, signal: init.signal })
    if (path === '/api/auth/sign-in/email') {
      assert.equal(method, 'POST'); assert.deepEqual(body, { email, password, rememberMe: false })
      assert.equal(headers.get('cookie'), null); signedIn = true
      return json({ user: { id: reader } }, 200, { 'set-cookie': 'session=' + cookie + '; Path=/; HttpOnly; Secure' })
    }
    assert.equal(signedIn, true)
    assert.equal(headers.get('cookie'), 'session=' + cookie)
    if (path === '/api/auth/sign-out') {
      assert.equal(method, 'POST'); assert.deepEqual(body, {}); assert.equal(budget.phase, 'signout')
      return options.signoutFailure ? json({}, 503) : json({ success: true }, 200, { 'set-cookie': 'session=; Max-Age=0; Path=/' })
    }
    if (path === '/api/auth/get-session') return json({ user: { id: reader, email } })
    if (path === '/api/workspace') return json({ currentUserId: reader, workspace: { id: b.workspaceId, kind: 'team' },
      role: 'member', choices: [{ id: b.workspaceId, kind: 'team' }], members: [
        { userId: reader, role: 'member', status: 'active' }, { userId: admin, role: 'admin', status: 'active' }] })
    if (path === '/api/integrations/github') return json({ viewerId: reader, connected: true, installed: true,
      repositories: [{ fullName: 'alexj11324/Mikka-handoff' }] })
    if (path === '/api/factory/agent-profiles') return json({ profiles: [{ ...profile,
      ...(options.changedProfile ? { version: profile.version + 1 } : {}) }], availability: { [b.profileId]: { available: true } } })
    if (path === '/api/settings/api-keys') return json({ apiKeyAfterQuota: false })
    if (path === '/api/bots/' + b.botId) return json({ id: b.botId })
    if (path === '/api/rpc') {
      assert.equal(method, 'POST'); assert.equal(headers.get('x-mikka-rpc'), '1')
      assert.deepEqual(Object.keys(body).sort(), ['action', 'args', 'version']); assert.equal(body.version, 1)
      const reply = value => json({ ok: true, result: value }), a = body.args
      if (body.action === 'bots.pollBots') return reply({ live: { ownerId: reader, workspaceId: b.workspaceId }, items: [{ id: b.botId }] })
      if (body.action === 'model-order.getModelOrder') return reply({ candidates: [{ harness: MODEL.harness, model: MODEL.model,
        source: { kind: 'subscription', connectionId: b.subscriptionConnectionId }, credentialOwnerId: admin }] })
      if (body.action === 'coordinator.pollCoordinatorChat') return reply({ botId: b.botId, enabled: true, working: false, streamRunId: null })
      if (body.action === 'execution-settings.getBotModelMenu') return reply({ groups: [
        { kind: 'subscription', provider: MODEL.provider, owner: 'synthetic-admin-label', options: [
          { id: b.chatChoiceId, modelId: MODEL.model, provider: MODEL.provider }] }],
        current: { id: b.chatChoiceId, kind: 'subscription', provider: MODEL.provider, modelId: MODEL.model, chosen: true, available: true } })
      if (body.action === 'task-runs.pollThreads') return reply({ items: [{ id: b.oldRunWitness.runId, issueId: b.oldRunWitness.taskId,
        createdAt: b.oldRunWitness.createdAt, status: 'succeeded', prompt: 'synthetic-private-old-prompt' }] })
      if (body.action === 'issues.getIssue') {
        assert.equal(a.length, 1)
        if (a[0] === b.oldRunWitness.taskId) return reply({ issue: { id: a[0], userId: reader, workspaceId: b.workspaceId,
          ownershipState: 'bound', scope: 'workspace' } })
        assert.equal(a[0], id(20)); return reply({ issue: issue() })
      }
      if (body.action === 'issues.saveIssue') {
        assert.equal(a.length, 1); assert.deepEqual(Object.keys(a[0]).sort(), ['content','priority','status','title'])
        assert.deepEqual(a[0], { title: doc.title, content: doc.content, status: 'todo', priority: 'normal' })
        return reply({ issue: issue() })
      }
      if (body.action === 'coordinator.sendCoordinatorMessage') {
        assert.equal(a[2], b.botId); assert.equal(a[3], doc.submissionId); assert.equal(a[8], b.profileId)
        assert.equal(submitted, false); submitted = true
        return options.dispatchReplyLost ? json({}, 503) : reply({ queued: true })
      }
      if (body.action === 'coordinator.stopCoordinatorTurn') {
        assert.deepEqual(a, [b.botId]); assert.equal(budget.phase, 'cleanup'); stopped = true; return reply({ ok: true })
      }
      if (body.action === 'agents.pollIssueThreads') {
        assert.deepEqual(a, [id(20)])
        return reply({ threads: submitted ? (state.cleanup ? runIds : [id(21)]).map(runId =>
          ({ id: runId, issueId: id(20), ownedByCurrentUser: options.foreignDiscoveredRun ? false : true, status: 'succeeded' })) : [] })
      }
      if (body.action === 'agents.getIssueThread') {
        assert.equal(a[0], id(20)); assert.ok(runIds.includes(a[1]))
        return reply({ thread: { id: a[1], issueId: id(20), ownedByCurrentUser: !options.foreignDiscoveredRun,
          status: 'succeeded' }, attempts: [] })
      }
      if (body.action === 'agents.getThreadMachine') {
        assert.equal(a[0], id(20)); assert.ok(machineEnds.includes(a[1]))
        return reply({ kind: 'cloud', state: 'ended', cloud: null })
      }
      assert.fail('unexpected action ' + body.action)
    }
    if (path === '/api/coordinator/stream') {
      assert.equal(submitted, true)
      const call = 'synthetic-dispatch-call'
      const events = [
        { type: 'tool', name: 'dispatch_run', state: 'running', call,
          input: JSON.stringify({ issueId: id(20) }), quote: '[1782:' + doc.submissionId + '] execute exact owned Task' },
        { type: 'tool', name: 'dispatch_run', state: 'done', call, output: JSON.stringify({ runId: id(21) }) }]
      return new Response(events.map(e => JSON.stringify(e)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } })
    }
    const evidence = /^\/api\/runs\/([a-f0-9-]{36})\/evidence$/.exec(path)
    if (evidence) { assert.ok(runIds.includes(evidence[1])); return json({ run: run(evidence[1]) }) }
    if (path === '/api/factory/tasks') return json({ issueId: id(20), liveWorkspaceId: b.workspaceId,
      tasks: submitted ? [{ id: id(23), issueId: id(20) }] : [] })
    if (path === '/api/factory/tasks/' + id(23)) {
      if (method === 'GET') return json(snapshot)
      assert.equal(budget.phase, 'cleanup'); assert.equal(stopped, true)
      assert.deepEqual(body.binding, { taskId: id(23), revision: 3 }); assert.equal(body.action, 'cancel')
      assert.equal(body.eventId, doc.submissionId); snapshot.task.status = 'cancelled'
      return json({ task: { id: id(23), status: 'cancelled' } })
    }
    if (path === '/api/factory/tasks/' + id(23) + '/flow') return json(flow)
    if (path === '/api/factory/tasks/' + id(23) + '/activity') {
      activityReads++
      const artifact = { id: 'pr:' + id(21), kind: 'pull_request', runId: id(21), attemptId: id(40),
        candidateId: id(25), state: 'open', url: flow.pullRequest.url, createdAt: '2026-11-09T20:01:00.000Z' }
      if (options.wrongPublicationAttempt) artifact.attemptId = id(99)
      const activity = { version: 1, observedAt: '2026-11-09T20:01:00.000Z',
        task: { ...flow, status: snapshot.task.status }, liveWorkspaceId: b.workspaceId,
        artifacts: options.missingPublication || options.delayedPublication && activityReads === 1 ? []
          : options.duplicatePublication ? [artifact, { ...artifact }] : [artifact] }
      // The normal scoped activity DTO masks flow PRs until a published artifact exists.
      if (activity.artifacts.length === 0 || options.missingActivityPullRequest) activity.task.pullRequest = null
      if (options.wrongActivityPullRequest) activity.task.pullRequest = { ...flow.pullRequest,
        url: 'https://github.com/alexj11324/Mikka-handoff/pull/999' }
      if (options.foreignActivityScope) activity.liveWorkspaceId = id(99)
      return json(activity)
    }
    const machine = /^\/api\/threads\/([a-f0-9-]{36})\/machine$/.exec(path)
    if (machine) {
      assert.equal(method, 'POST'); assert.equal(budget.phase, 'cleanup'); assert.deepEqual(body, { action: 'end' })
      assert.ok(runIds.includes(machine[1])); machineEnds.push(machine[1])
      return options.machineFailure === machine[1] ? json({}, 503) : json({ runId: machine[1], state: 'ended' })
    }
    assert.fail('unexpected path ' + path)
  }
  const client = createFixtureClient(b, state, budget, fetchImpl), clear = client.clear
  client.clear = () => { clears++; clear() }
  const pin = async () => { assert.equal(budget.phase, 'work'); budget.signal('work').throwIfAborted(); pins++
    return { mainSha: b.applicationSha, build: b.applicationSha, windowCommentId: b.windowCommentId } }
  const observe = async (wire, record, timeoutMs, WebSocketImpl, now, cleanupRunIds, hooks) => {
    assert.equal(wire, client); assert.ok(timeoutMs > 0 && timeoutMs <= 20 * 60000)
    assert.equal(typeof now, 'function'); assert.equal(cleanupRunIds, null)
    assert.equal(hooks.allowTerminal, true); assert.ok(hooks.signal instanceof AbortSignal)
    if (options.emptyObservation) return
    const detail = await wire.rpc('agents.getIssueThread', [record.issueId, record.runId])
    const hookContext = { checkActive: () => hooks.signal.throwIfAborted(),
      watchScope: workspaceId => assert.equal(workspaceId, b.workspaceId), watchRun: runId => watched.push(runId) }
    const finished = await hooks.observe(detail, hookContext)
    if (options.missingPublication || options.delayedPublication) {
      assert.equal(finished, false); assert.equal(record.delivery, undefined)
      assert.equal(state.cleanup, false); assert.equal(state.cancelCalls, 0); assert.deepEqual(machineEnds, [])
      if (options.missingPublication) return
      assert.equal(await hooks.observe(detail, hookContext), true)
    } else assert.equal(finished, true)
    assert.ok(record.delivery)
  }
  return { b, state, calls, machineEnds, runIds, watched, budget,
    async run() {
      try {
        const report = await capture(client, env, b, state, text, { budget, pin, observe, now: budget.now })
        assert.equal(clears, 1); assert.equal(budget.activeTimers, 0)
        const serialized = JSON.stringify(report)
        for (const privateValue of [email, password, cookie, reader, admin, 'synthetic-private-old-prompt'])
          assert.equal(serialized.includes(privateValue), false)
        return report
      } finally { budget.dispose() }
    }, get pins() { return pins }, get activityReads() { return activityReads } }
}

test('complete normal wire capture creates once, proves subscription/Factory publication, and closes its own resources', async () => {
  const f = fixture(), report = await f.run()
  assert.equal(report.status, 'publication_observed_pending_independent_verification')
  assert.equal(report.failure, undefined); assert.equal(report.oldRunWitness.reauthorized, true)
  assert.deepEqual([f.state.createCalls, f.state.dispatchCalls, f.state.cancelCalls], [1,1,1])
  assert.ok(f.pins >= 4); assert.equal(report.record.execution.sharedScope.verified, true)
  assert.equal(report.record.delivery.independentGithubVerificationRequired, true)
  assert.equal(report.record.delivery.exactReadonlyAppPublishedRowRequired, true)
  assert.equal(report.record.delivery.publishedActivity.normalPublishedStatusFilter, true)
  assert.equal(report.record.delivery.publishedActivity.attemptId, id(40))
  assert.ok(report.limitations.includes('not_a_before_snapshot'))
  assert.equal(report.cleanup.status, 'passed'); assert.equal(report.cleanup.signedOut, true)
  assert.equal(report.cleanup.tasksRetained, true); assert.equal(report.cleanup.pullRequestRetainedUntilAfter, true)
  assert.equal(report.cleanup.branchRetainedUntilAfter, true)
  assert.deepEqual(f.machineEnds, [id(21)])
  assert.deepEqual(report.cleanup.machines.map(m => [m.runId,m.acknowledgedEnded,m.machineReadbackEnded]), [[id(21),true,true]])
  assert.ok(f.calls.every(c => ['work','cleanup','signout'].includes(c.phase)))
  assert.equal(f.calls.at(-1).path, '/api/auth/sign-out')
})

test('actual resource drift stops before Task creation and dispatch, then signs out', async () => {
  const f = fixture({ changedProfile: true }), report = await f.run()
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'resource_changed')
  assert.deepEqual([f.state.createCalls,f.state.dispatchCalls,f.state.cancelCalls], [0,0,0])
  assert.deepEqual(f.machineEnds, []); assert.equal(report.cleanup.signedOut, true)
})

test('a safe owned Task ID survives a malformed creation reply without dispatch or a second create', async () => {
  const f = fixture({ invalidTaskRevision: true }), report = await f.run()
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'task_invalid')
  assert.equal(report.record.issueId, id(20)); assert.equal(f.state.issueId, id(20))
  assert.deepEqual([f.state.createCalls,f.state.dispatchCalls], [1,0])
  assert.deepEqual(f.machineEnds, []); assert.equal(report.cleanup.signedOut, true)
})

test('an accepted dispatch with a lost response is never resent and discovers only owned runs for cleanup', async () => {
  const f = fixture({ dispatchReplyLost: true }), report = await f.run()
  assert.equal(report.status, 'failed'); assert.ok(report.failure)
  assert.equal(f.state.dispatchCalls, 1); assert.equal(report.record.runId, undefined)
  assert.equal(report.record.delivery, undefined)
  assert.deepEqual(f.machineEnds, [id(21)])
  assert.ok(f.calls.some(c => c.action === 'agents.pollIssueThreads' && c.phase === 'cleanup'))
  assert.ok(f.calls.some(c => c.path === '/api/runs/' + id(21) + '/evidence' && c.phase === 'cleanup'))
  assert.ok(report.cleanup.errors.some(e => e.code === 'dispatch_unknown'))
  assert.equal(report.cleanup.signedOut, true)
})

test('unknown dispatch never gains machine authority from a foreign Task thread', async () => {
  const f = fixture({ dispatchReplyLost: true, foreignDiscoveredRun: true }), report = await f.run()
  assert.equal(report.status, 'failed'); assert.equal(f.state.dispatchCalls, 1)
  assert.deepEqual(f.machineEnds, []); assert.equal(report.record.runId, undefined)
  assert.equal(report.cleanup.status, 'failed'); assert.equal(report.cleanup.signedOut, true)
})

test('failure to end one owned machine does not suppress the other exact machine cleanup', async () => {
  const f = fixture({ secondRun: true, machineFailure: id(21) }), report = await f.run()
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.status, 'failed')
  assert.deepEqual([...f.machineEnds].sort(), [id(21),id(26)])
  assert.ok(report.cleanup.errors.length > 0)
  assert.deepEqual(report.cleanup.machines.map(m => m.runId), [id(26)])
  assert.equal(report.cleanup.signedOut, true)
})

test('an observer that resolves without a real publication receipt cannot produce successful capture', async () => {
  const f = fixture({ emptyObservation: true }), report = await f.run()
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'publication_invalid')
  assert.equal(report.record.delivery, undefined); assert.deepEqual(f.machineEnds, [id(21)])
  assert.equal(report.cleanup.signedOut, true)
})

test('signout failure is visible and does not replace the primary resource validation failure', async () => {
  const f = fixture({ changedProfile: true, signoutFailure: true }), report = await f.run()
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'resource_changed')
  assert.equal(report.cleanup.signedOut, false)
  assert.deepEqual([f.state.createCalls,f.state.dispatchCalls], [0,0])
})

test('an open PR alone keeps observing until its exact normal published activity appears', async () => {
  const f = fixture({ delayedPublication: true }), report = await f.run()
  assert.equal(report.status, 'publication_observed_pending_independent_verification')
  assert.equal(f.activityReads, 2); assert.equal(report.record.delivery.publishedActivity.attemptId, id(40))
  assert.equal(f.state.cancelCalls, 1); assert.equal(report.cleanup.signedOut, true)
})

for (const [name, options] of [
  ['missing published activity', { missingPublication: true }],
  ['other execution attempt', { wrongPublicationAttempt: true }],
  ['duplicate published activity', { duplicatePublication: true }],
  ['foreign live Workspace', { foreignActivityScope: true }],
  ['published artifact without activity PR', { missingActivityPullRequest: true }],
  ['published artifact with different activity PR', { wrongActivityPullRequest: true }],
]) test('publication observation refuses ' + name, async () => {
  const f = fixture(options), report = await f.run()
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'publication_invalid')
  assert.equal(report.record.delivery, undefined); assert.equal(f.state.dispatchCalls, 1)
  assert.deepEqual(f.machineEnds, [id(21)]); assert.equal(report.cleanup.signedOut, true)
})

test('a passed Factory stage still receives exact cancellation before machines end', async () => {
  const f = fixture({ passedStage: true }), report = await f.run()
  assert.equal(report.status, 'publication_observed_pending_independent_verification')
  assert.equal(f.state.cancelCalls, 1); assert.equal(report.cleanup.status, 'passed')
  assert.deepEqual(f.machineEnds, [id(21)]); assert.equal(report.cleanup.signedOut, true)
})
