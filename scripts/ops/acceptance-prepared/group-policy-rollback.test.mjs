import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { runGroupPolicyRollback, runGroupPolicyRollbackBundle } from './group-policy-rollback.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const hash = text => createHash('sha256').update(text).digest('hex')
const BASE = 'group-route-v0', CANDIDATE = 'group-contribution-v1'
const ownerId = 'synthetic-owner', email = 'synthetic-smoke@example.invalid', source = 'a'.repeat(40), build = 'dpl_SyntheticPolicyOnly'
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })

function harness(options = {}) {
  let clock = Date.parse('2026-11-04T00:00:00Z'), seq = 100
  const state = { calls: [], bots: [], group: null, members: [], models: new Map(), profiles: new Map(), turns: [], messages: [],
    policy: options.delegate || options.neverBaseline || options.warmup ? CANDIDATE : BASE, checkpoints: [], waits: [], submissions: 0,
    stopCalls: 0, task: null, run: null, cancelCalls: 0, endCalls: 0, qualityReads: 0, qualityReadsAfterStop: 0 }
  function makeTurn(body) {
    const messageId = id(seq++), replyId = id(seq++), stepId = id(seq++), bot = state.bots[0], text = '保存时显示进度并禁用重复提交。'
    const policy = state.policy
    const receipt = { executionId: 'execution-' + messageId, providerGenerationId: 'generation-' + messageId,
      modelId: 'openai/gpt-6-luna-decisions', requestDigest: hash(body.body), imageDigests: [],
      startedAt: new Date(clock).toISOString(), completedAt: new Date(clock + 1).toISOString() }
    const step = { id: stepId, index: 0, phase: policy === BASE ? 'responder' : 'intent', status: 'complete', failure: null,
      policyVersion: options.mixedPolicy ? (policy === BASE ? CANDIDATE : BASE) : policy, receipt, decisionCostUsd: 0.00001 }
    const events = ['wake', 'generate', 'publish'].map(type => ({ id: type + '-' + messageId, type, memberId: bot.id,
      ...(type === 'publish' ? { contentDigest: hash(text) } : {}) }))
    const trace = { status: 'complete', action: 'reply', policyVersion: policy, decisionProtocol: 'group-sequential-v1',
      execution: receipt, decisions: [step], decisionsOmitted: 0, responders: [bot.id], events, privatePrompt: 'PRIVATE_SENTINEL' }
    const root = { id: messageId, position: String(state.messages.length + 1), authorType: 'user', authorId: ownerId, body: body.body }
    const reply = { id: replyId, position: String(state.messages.length + 2), authorType: 'bot', authorId: bot.id, replyToId: messageId, body: text }
    state.messages.push(root, reply)
    const turn = { messageId, status: 'complete', trace }
    if (options.pending) { turn.status = 'failed'; turn.error = 'group_judgment_pending'; trace.status = 'blocked' }
    if (options.delegate) {
      state.task = { id: id(701), userId: ownerId, botId: bot.id, issueId: id(702), sourceEventId: id(703), attemptId: id(704), candidateId: null, revision: 1, status: 'running', stage: 'execute' }
      state.attempt = { id: id(704), runId: id(705), output: { requestEpoch: id(703) } }
      state.run = { id: id(705), issueId: id(702), botId: bot.id, status: 'running', executionIdentity: {
        requester: options.foreignRun ? 'foreign-owner' : ownerId, executionPrincipal: ownerId, outputOwner: ownerId,
        botOwner: ownerId, botId: bot.id, workspaceId: id(2), billingAccount: { runtime: { ownerId, kind: 'e2b' } } } }
      trace.action = 'delegate'; trace.events = [{ id: 'delegate-' + messageId, type: 'delegate', outcome: 'succeeded', taskId: id(701), runId: id(705), memberId: bot.id }]
      if (options.delegateLate) { state.deferredDelegate = trace.events; trace.events = [] }
      state.messages.pop()
    }
    state.turns.push(turn)
    if (options.warmup && state.submissions === 1) state.policy = BASE
    return root
  }
  async function request(path, init = {}) {
    clock++
    const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : undefined
    state.calls.push({ path, method, body })
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal)
    if (path === '/api/version') return response({ build: options.wrongBuild ? 'dpl_Other' : build })
    if (path === '/api/auth/sign-in/email') return response({ ok: true }, 200, { 'set-cookie': 'synthetic_session=PRIVATE_COOKIE; HttpOnly' })
    if (path === '/api/auth/sign-out') return response({ ok: true }, options.logoutFailure ? 503 : 200)
    if (path === '/api/auth/get-session') return response({ user: { id: ownerId, email } })
    if (path === '/api/bots') {
      if (method === 'POST') {
        const bot = { id: id(seq++), name: body.name, ownerId, workspaceId: id(2) }; state.bots.push(bot)
        return response(bot, 201)
      }
      return response(state.bots)
    }
    if (path.startsWith('/api/bots/')) {
      const botId = path.split('/').at(-1)
      if (method === 'PATCH') { state.profiles.set(botId, body.publicRole); return response({ ok: true }) }
      return response({ id: botId, publicRole: state.profiles.get(botId) })
    }
    if (path.startsWith('/api/mobile/model?bot=')) return response({ current: state.models.get(path.split('=').at(-1)), groups: [{ kind: 'apiKey', options: [{ id: 'apikey:' + id(900) + ':deepseek-flash', provider: 'deepseek', modelId: 'deepseek-flash' }] }] })
    if (path === '/api/mobile/model') {
      assert.equal(method, 'PUT'); assert.ok(state.bots.some(bot => bot.id === body.bot))
      state.models.set(body.bot, { id: body.id, kind: 'apiKey', provider: 'deepseek', modelId: 'deepseek-flash', available: true })
      return response({ current: state.models.get(body.bot) })
    }
    if (path === '/api/conversations') {
      assert.equal(method, 'POST')
      state.group = { id: id(3), title: body.title, workspaceId: body.workspaceId, createdBy: ownerId, kind: 'group', createdAt: new Date(clock).toISOString() }
      state.members = [{ memberType: 'user', id: ownerId, role: 'owner' }, ...state.bots.map(bot => ({ memberType: 'bot', id: bot.id, role: 'member' }))]
      return response({ id: id(3), title: body.title }, 201)
    }
    if (path.startsWith('/api/conversations?')) return response({ conversations: state.group ? [state.group] : [] })
    const base = '/api/conversations/' + id(3)
    if (path === base + '/members') return response({ members: options.memberDrift && state.submissions ? state.members.slice(0, 3) : state.members })
    if (path === base + '/decisions?limit=100') {
      state.qualityReads++
      if (state.stopCalls) state.qualityReadsAfterStop++
      if (options.delegateLate && state.qualityReadsAfterStop >= 4) state.turns[0].trace.events = state.deferredDelegate
      if (options.pendingRecovers && state.qualityReads > 5) for (const turn of state.turns) { turn.status = 'complete'; turn.error = null; turn.trace.status = 'complete' }
      return response({ turns: state.turns, feedbackIsGroundTruth: false, costScope: 'routing-decision-chain' })
    }
    if (path === base + '/messages?limit=100') return response({ messages: state.messages })
    if (path === base + '/messages') {
      assert.equal(method, 'POST'); state.submissions++
      assert.deepEqual(body.mentions, [{ memberType: 'bot', memberId: state.bots[0].id }])
      const message = makeTurn(body)
      if (options.unknownMessage) throw Error('PRIVATE_UPSTREAM_CREDENTIAL')
      return response(message, 201)
    }
    if (path === base + '/stop') {
      state.stopCalls++
      for (const turn of state.turns) if (turn.status !== 'complete') { turn.status = 'failed'; turn.error = 'stopped'; turn.trace.status = 'stopped' }
      if (options.unknownStop) throw Error('PRIVATE_UPSTREAM_ERROR')
      return response({ stoppedTurns: 0 })
    }
    if (state.task && path === '/api/factory/tasks/' + state.task.id) {
      if (method === 'POST') {
        state.cancelCalls++; assert.equal(body.action, 'cancel'); assert.equal(body.binding.taskId, state.task.id)
        state.task.status = 'cancelled'; state.task.revision++; state.run.status = 'stopped'
      }
      if (options.epochDrift && state.cancelCalls) state.task.sourceEventId = id(999)
      return response({ task: state.task, attempts: [state.attempt] })
    }
    if (state.run && path === '/api/runs/' + state.run.id + '/evidence') return response({ run: state.run, artifacts: [] })
    if (state.run && path === '/api/threads/' + state.run.id + '/machine') {
      state.endCalls++; assert.equal(state.run.status, 'stopped'); assert.deepEqual(body, { action: 'end' })
      return response({ runId: state.run.id, state: 'ended' }, options.unknownEnd ? 404 : 200)
    }
    assert.fail('Unexpected endpoint ' + path)
  }
  const onCheckpoint = async checkpoint => { state.checkpoints.push(checkpoint); if (checkpoint.type === 'baseline_observed' && !options.neverCandidate) state.policy = CANDIDATE }
  const args = { owner: { request }, verifyTarget: async ({ signal }) => { assert.ok(signal instanceof AbortSignal); clock++; if (options.targetDrift) throw Error('PRIVATE_DRIFT') },
    assertFlashTestModel: value => assert.equal(value, 'deepseek-flash'), decisionModelId: 'openai/gpt-6-luna-decisions',
    onCheckpoint, now: () => clock, wait: async ms => { state.waits.push(ms); clock += ms } }
  return { args, state, request, onCheckpoint, clock: () => clock }
}

test('manual roundtrip keeps cache-period observations, waits at least61s and passes only actual bound baseline then candidate traces', async () => {
  const h = harness({ warmup: true }), report = await runGroupPolicyRollback(h.args)
  assert.equal(report.status, 'passed'); assert.equal(report.messageAttempts, 3)
  assert.deepEqual(report.observations.map(row => row.policyVersion), [CANDIDATE, BASE, CANDIDATE])
  assert.deepEqual(report.phases.map(row => row.status), ['observed', 'observed'])
  assert.deepEqual(h.state.waits, [61_000, 61_000]); assert.equal(h.state.stopCalls, 1)
  assert.equal(report.cleanup.group.noPendingRetry, true); assert.equal(report.policyChangedByRunner, false)
  assert.equal(report.callerSessionAndCredentialCleanupRequired, true)
  assert.equal(new Set(h.state.calls.filter(row => row.path.endsWith('/messages') && row.method === 'POST').map(row => row.body.body)).size, 3)
  for (const privateValue of ['PRIVATE', '保存按钮', '负责界面', 'example.invalid', 'apikey:']) assert.equal(JSON.stringify(report).includes(privateValue), false)
})

test('a policy that never changes exhausts the bounded probes and cannot pass from operator intent alone', async () => {
  const h = harness({ neverBaseline: true }), report = await runGroupPolicyRollback(h.args)
  assert.equal(report.status, 'failed'); assert.equal(h.state.submissions, 4)
  assert.ok(report.errors.includes('policy_acceptance_policy_not_observed')); assert.equal(h.state.stopCalls, 1)
})

test('wrong stage policy and membership drift stop work instead of displaying a successful roundtrip', async () => {
  for (const options of [{ mixedPolicy: true }, { memberDrift: true }]) {
    const h = harness(options), report = await runGroupPolicyRollback(h.args)
    assert.equal(report.status, 'failed'); assert.equal(h.state.submissions, 1)
  }
})

test('unknown submission is never resent; scoped stop is observed without claiming no provider call or paid cost', async () => {
  const h = harness({ unknownMessage: true }), report = await runGroupPolicyRollback(h.args)
  assert.equal(report.status, 'failed'); assert.equal(h.state.submissions, 1); assert.equal(h.state.stopCalls, 1)
  assert.equal(report.cleanup.unobservedSubmission, true); assert.equal(report.observations.length, 0)
  assert.equal(report.cleanup.group.noPendingRetry, true); assert.equal(JSON.stringify(report).includes('PRIVATE'), false)
})

test('recoverable pending is awaited inside the original budget; an unconfirmed stop is not replayed or claimed', async () => {
  const h = harness({ pending: true, pendingRecovers: true }), report = await runGroupPolicyRollback(h.args)
  assert.equal(report.status, 'passed'); assert.ok(h.state.qualityReads > 5)
  const bad = harness({ unknownStop: true }), failed = await runGroupPolicyRollback(bad.args)
  assert.equal(failed.status, 'failed'); assert.equal(bad.state.stopCalls, 1)
  assert.equal(failed.cleanup.group.acknowledged, false); assert.equal(failed.cleanup.group.noPendingRetry, true)
})

test('unexpected work is cancelled only after host trace/epoch/frozen owner binding, and its exact terminal E2B run is ended once', async () => {
  const h = harness({ delegate: true }), report = await runGroupPolicyRollback(h.args)
  assert.equal(report.status, 'failed'); assert.equal(h.state.submissions, 1)
  assert.equal(h.state.cancelCalls, 1); assert.equal(h.state.endCalls, 1)
  assert.equal(report.cleanup.machines[0].executionStopConfirmed, true)
  assert.equal(report.cleanup.machines[0].machineEndAcknowledged, true)
  assert.equal(report.cleanup.machines[0].independentProviderObservation, false)
  assert.equal(report.cleanup.machines.length, 1, 'the final scan never repeats the already attempted task/run cleanup')
  assert.equal(report.failedTurns.length, 1); assert.equal(report.failedTurns[0].knownCostUsd, 0.00001)
})

test('a confirmed201 root that remains pending after delegation and times out is still cleaned through its trusted receipt', async () => {
  const h = harness({ delegate: true, pending: true }), report = await runGroupPolicyRollback(h.args)
  assert.equal(report.status, 'failed'); assert.ok(report.errors.includes('policy_acceptance_turn_timeout'))
  assert.equal(h.state.submissions, 1); assert.equal(h.state.stopCalls, 1)
  assert.equal(h.state.cancelCalls, 1); assert.equal(h.state.endCalls, 1)
  assert.equal(report.cleanup.knownDelegationsReviewed, true); assert.equal(report.cleanup.machines[0].status, 'ended')
})

test('a lost201 response cannot authorize guessing and cancelling a Task from the later group listing', async () => {
  const h = harness({ delegate: true, unknownMessage: true }), report = await runGroupPolicyRollback(h.args)
  assert.equal(report.status, 'failed'); assert.equal(h.state.stopCalls, 1)
  assert.equal(report.cleanup.unobservedSubmission, true); assert.equal(report.cleanup.unboundDelegateObserved, true)
  assert.equal(h.state.cancelCalls, 0); assert.equal(h.state.endCalls, 0)
})

test('a host delegation receipt arriving after chat stop is awaited read-only and cleaned once within the same budget', async () => {
  const h = harness({ delegate: true, pending: true, delegateLate: true }), report = await runGroupPolicyRollback(h.args)
  assert.equal(report.status, 'failed'); assert.ok(report.errors.includes('policy_acceptance_turn_timeout'))
  assert.equal(h.state.cancelCalls, 1); assert.equal(h.state.endCalls, 1)
  assert.equal(h.state.stopCalls, 1); assert.equal(report.cleanup.knownDelegationsReviewed, true)
  assert.ok(h.state.waits.includes(2000))
  const stopIndex = h.state.calls.findIndex(row => row.path.endsWith('/stop'))
  assert.equal(h.state.calls.slice(stopIndex + 1).some(row => row.path.endsWith('/messages?limit=100')), false)
})

test('foreign run identity, changed epoch and unknown machine end never broaden or replay cleanup', async () => {
  for (const [options, cancel, end] of [[{ foreignRun: true }, 0, 0], [{ epochDrift: true }, 1, 0], [{ unknownEnd: true }, 1, 1]]) {
    const h = harness({ delegate: true, ...options }), report = await runGroupPolicyRollback(h.args)
    assert.equal(report.status, 'failed'); assert.equal(h.state.cancelCalls, cancel); assert.equal(h.state.endCalls, end)
    assert.equal(report.cleanup.machines[0].machineEndAcknowledged, false)
  }
})

test('source drift fails before any fixture write, and a short budget never bypasses the61s interval', async () => {
  const h = harness({ targetDrift: true }), report = await runGroupPolicyRollback(h.args)
  assert.equal(report.status, 'failed'); assert.equal(h.state.calls.length, 0)
  const short = harness(), limited = await runGroupPolicyRollback({ ...short.args, budgetMs: 1000 })
  assert.equal(limited.status, 'failed'); assert.equal(short.state.submissions, 1); assert.equal(short.state.stopCalls, 1)
})

test('a blocked checkpoint emitter cannot hold the owner session and key beyond the work deadline', async () => {
  const h = harness()
  // Keep the Node test loop alive while AbortSignal's unref timer enforces the
  // bound. This is an offline callback fault, not a sleep or provider request.
  const live = setInterval(() => {}, 20)
  try {
    const report = await runGroupPolicyRollback({ ...h.args, budgetMs: 1000, onCheckpoint: async () => new Promise(() => {}) })
    assert.equal(report.status, 'failed'); assert.ok(report.errors.includes('policy_acceptance_checkpoint_timeout'))
    assert.equal(h.state.submissions, 1); assert.equal(h.state.stopCalls, 1)
  } finally { clearInterval(live) }
})

function bundle(options = {}) {
  const h = harness(options), env = { SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: 'PRIVATE_PASSWORD',
    GROUP_ACCEPTANCE_REVISION: source, GROUP_ACCEPTANCE_DEPLOYMENT: build }
  const dependencies = { isSmokeAccountEmail: value => value === email, assertFlashTestModel: h.args.assertFlashTestModel,
    DECISION_MODEL: 'openai/gpt-6-luna-decisions',
    withTemporaryFlashCredential: async (run, config) => {
      assert.equal(config.cloudExecution, false)
      const cleanup = { created: true, removed: false }
      const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
      await config.fetchImpl('https://app.aspectlylabs.com/mikka/api/auth/sign-in/email', init)
      try { return await run(cleanup) }
      finally { cleanup.removed = !options.keyCleanupFailure; await config.fetchImpl('https://app.aspectlylabs.com/mikka/api/auth/sign-out', init) }
    } }
  const fetchImpl = async (url, init) => h.request(new URL(url).pathname.replace(/^\/mikka/, '') + new URL(url).search, init)
  return { h, args: { env, dependencies, fetchImpl, verifySource: () => options.sourceMismatch ? 'b'.repeat(40) : source,
    now: h.args.now, wait: h.args.wait, onCheckpoint: h.onCheckpoint } }
}

test('the normal caller requires both session logouts and temporary-key cleanup; it never requests a Cloud credential', async () => {
  const b = bundle(), report = await runGroupPolicyRollbackBundle(b.args)
  assert.equal(report.status, 'passed'); assert.equal(report.group.status, 'passed')
  assert.deepEqual(report.credentialCleanup, { created: true, removed: true })
  assert.ok(Object.values(report.sessionCleanup).every(row => row.loginStatus === 200 && row.logoutStatus === 200))
  assert.equal(report.cloudCredentialCreated, false)
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|example\.invalid/)
  for (const options of [{ keyCleanupFailure: true }, { logoutFailure: true }]) {
    const denied = bundle(options), failed = await runGroupPolicyRollbackBundle(denied.args)
    assert.equal(failed.status, 'failed')
  }
})

test('fixed source and deployment are checked before login or fixture/model work', async () => {
  const sourceWrong = bundle({ sourceMismatch: true })
  await assert.rejects(runGroupPolicyRollbackBundle(sourceWrong.args), /source_revision_mismatch/)
  assert.equal(sourceWrong.h.state.calls.length, 0)
  const deploymentWrong = bundle({ wrongBuild: true }), failed = await runGroupPolicyRollbackBundle(deploymentWrong.args)
  assert.equal(failed.status, 'failed'); assert.equal(deploymentWrong.h.state.calls.length, 1)
  assert.equal(deploymentWrong.h.state.bots.length, 0)
})
