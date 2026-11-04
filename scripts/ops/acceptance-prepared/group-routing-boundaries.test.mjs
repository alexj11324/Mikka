import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { runGroupRoutingBoundaries } from './group-routing-boundaries.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const digest = text => createHash('sha256').update(text).digest('hex')
const ownerId = 'synthetic-owner'
const sourcePin = { revision: 'a'.repeat(40), deploymentId: 'dpl_SyntheticOnly' }
const originalRoles = { UI: '负责界面设计、用户交互与可用性。', Coding: '负责代码实现与修复软件缺陷。', Testing: '负责测试设计、回归测试与质量验证。' }
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

function harness(options = {}) {
  let clock = Date.parse('2026-11-04T00:00:01Z'), sequence = 100
  const fixtureId = id(1), workspaceId = id(2), conversationId = id(3)
  const roles = ['UI', 'Coding', 'Testing'], bots = roles.map((role, i) => ({ id: id(i + 4), name: 'Acceptance ' + role + ' ' + fixtureId.slice(0, 8), ownerId, workspaceId }))
  const fixture = { exclusive: true, fixtureId, ownerId, workspaceId, startedAt: '2026-11-04T00:00:00Z',
    bots: bots.map((b, i) => ({ role: roles[i], modelId: 'deepseek-flash', creationReceipt: { status: 201, body: { ...b } } })),
    conversationReceipt: { status: 201, body: { id: conversationId, title: 'Proactive acceptance ' + fixtureId.slice(0, 8) },
      request: { workspaceId, title: 'Proactive acceptance ' + fixtureId.slice(0, 8), members: bots.map(b => ({ memberType: 'bot', memberId: b.id })) } } }
  const state = { requests: [], messages: [], turns: [], roles: { ...originalRoles },
    members: [{ id: ownerId, memberType: 'user', role: 'owner' }, ...bots.map(b => ({ id: b.id, memberType: 'bot', role: 'member' }))],
    position: 0, submitted: 0, roleWrites: [], memberWrites: [], modelWrites: [], models: new Map(), cancelWrites: [], endWrites: [], stopWrites: 0,
    task: null, run: null, qReads: new Map(), afterStopReads: 0 }
  const group = { id: conversationId, title: fixture.conversationReceipt.body.title, workspaceId, createdBy: ownerId,
    kind: 'group', createdAt: '2026-11-04T00:00:00.100Z', leadAgentId: null, leadBotId: null }
  const gid = '/api/conversations/' + conversationId
  function roleOf(botId) { return roles[bots.findIndex(b => b.id === botId)] }
  function normalReply(body) {
    if (body.includes('今天午饭')) return options.replyOnQuiet ? [0] : []
    if (body.includes('婚礼')) return []
    if (body.includes('刚才的说明')) return []
    if (body.includes('[0, 1, 2]')) return [1]
    if (body.includes('登录表单')) return [2]
    if (body.includes('移动端提交')) return [0, 2]
    if (body.includes('代数题')) return [1]
    return [1]
  }
  function makeTurn(body, mentions, replyToId) {
    const messageId = id(sequence++), selected = normalReply(body)
    const root = { id: messageId, position: String(++state.position), body, authorType: 'user', authorId: ownerId, mentions, replyToId: replyToId ?? null }
    state.messages.push(root)
    const pending = options.pending || options.recoverPending && state.submitted === 1
    const trace = { status: pending ? 'pending' : 'complete', policyVersion: 'group-contribution-v2', decisionProtocol: 'group-sequential-v1',
      action: selected.length ? 'reply' : 'ignore', responders: selected.map(i => bots[i].id),
      members: bots.map((b, i) => ({ id: b.id, roleDigest: digest(JSON.stringify(state.roles[roles[i]])) })),
      execution: { executionId: 'decision-' + messageId, providerGenerationId: 'generation-' + messageId,
        modelId: 'openai/gpt-6-luna-decisions', requestDigest: digest(body), imageDigests: [],
        startedAt: new Date(clock).toISOString(), completedAt: new Date(clock + 1).toISOString() }, events: [] }
    trace.decisions = [{ id: id(sequence++), index: 0, phase: 'intent', policyVersion: trace.policyVersion,
      status: 'complete', failure: null, receipt: trace.execution, decisionCostUsd: 0.00001 }]
    for (let index = 0; index < selected.length; index++) trace.decisions.push({ id: id(sequence++), index: index + 1,
      phase: 'responder', policyVersion: trace.policyVersion, status: 'complete', failure: null,
      receipt: { ...trace.execution, executionId: 'responder-' + messageId + '-' + index,
        providerGenerationId: 'responder-generation-' + messageId + '-' + index }, decisionCostUsd: 0.00001 })
    if (options.missingChain) delete trace.decisions
    if (options.mixedChain) trace.decisions[0].policyVersion = 'group-route-v0'
    if (options.invalidFirst && state.submitted === 1) {
      trace.status = 'pending'; trace.decisions[0].status = 'invalid_decision'; trace.decisions[0].failure = 'uncertain'
      if (options.unknownCost) trace.decisions[0].decisionCostUsd = null
    }
    if (options.wakeOnQuiet && body.includes('今天午饭')) trace.events.push({ id: 'wake-quiet', type: 'wake', memberId: bots[0].id })
    if (options.delegateFirst && state.submitted === 1) {
      const taskId = id(700), runId = id(701), issueId = id(702), epoch = id(703), attemptId = id(704)
      trace.action = 'delegate'; trace.responders = [bots[1].id]
      trace.events = [{ id: 'trusted-delegate', type: 'delegate', memberId: bots[1].id, taskId, runId, outcome: 'succeeded' }]
      state.task = { id: taskId, userId: ownerId, botId: bots[1].id, issueId, sourceEventId: epoch, attemptId, candidateId: null, revision: 1, stage: 'execute', status: 'running' }
      state.attempt = { id: attemptId, runId, output: { requestEpoch: epoch } }
      state.run = { id: runId, issueId, botId: bots[1].id, status: 'running', executionIdentity: { requester: options.wrongDelegationOwner ? 'foreign-owner' : ownerId,
        executionPrincipal: ownerId, outputOwner: ownerId, botOwner: ownerId, botId: bots[1].id, workspaceId,
        billingAccount: { runtime: { kind: 'e2b', ownerId } } } }
      if (options.lateDelegate) { state.deferredEvents = trace.events; trace.events = [] }
    } else if (!pending) {
      for (const i of selected) {
        const text = i === 0 ? '提交按钮加载时禁用，防止重复点击。' : i === 2 ? '连续双击提交，断言只创建一次订单；空密码和错误密码都应验证失败。' : body.includes('代数题') ? '移项得到 3x = 15，相除得到 x = 5。' : 'Boolean(0) 是 false；可以用 value != null 只过滤空值。'
        const message = { id: id(sequence++), position: String(++state.position), replyToId: messageId, authorType: 'bot', authorId: bots[i].id, body: text }
        state.messages.push(message)
        if (!options.missingWake) trace.events.push({ id: 'wake-' + message.id, type: 'wake', memberId: bots[i].id })
        trace.events.push({ id: 'generate-' + message.id, type: 'generate', memberId: bots[i].id },
          { id: 'publish-' + message.id, type: 'publish', memberId: bots[i].id, contentDigest: digest(text.trim()) })
      }
      if (options.nonSequential && selected.length === 2) trace.events = [trace.events[0], trace.events[1], trace.events[3], trace.events[4], trace.events[2], trace.events[5]]
    }
    const turn = { messageId, status: pending ? options.recoverPending ? 'failed' : 'queued' : 'complete',
      error: options.recoverPending && pending ? 'group_judgment_pending' : null, trace }
    if (options.invalidFirst && state.submitted === 1) { turn.status = 'failed'; turn.error = 'group_judgment_pending' }
    state.turns.push(turn)
    return root
  }
  async function request(path, init = {}) {
    clock += 1
    const method = init.method ?? 'GET', body = init.body === undefined ? undefined : JSON.parse(init.body)
    state.requests.push({ path, method, body })
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal instanceof AbortSignal)
    if (path === '/api/auth/get-session') return response({ user: { id: ownerId, email: 'never-output@example.invalid' } })
    if (path === '/api/bots') return response(bots.map(b => ({ ...b, ownerId: options.foreignBot ? 'foreign-owner' : b.ownerId })))
    if (path.startsWith('/api/conversations?')) return response({ conversations: [{ ...group, lastPosition: String(state.position) }] })
    if (path.startsWith('/api/mobile/model?')) {
      const botId = path.split('=').at(-1)
      const current = state.models.get(botId) ?? (options.expiredFixtureKey
        ? { kind: 'hosted', provider: 'mikka', available: true, modelId: 'mikka', fallback: 'preference' }
        : { kind: 'apiKey', provider: 'deepseek', available: !options.unavailableModel, modelId: options.wrongModel ? 'unapproved-pro' : 'deepseek-flash' })
      return response({ current, groups: options.noFlashOption ? [] : [{ kind: 'apiKey', options: [{ id: 'apikey:' + id(900) + ':deepseek-flash', provider: 'deepseek', modelId: 'deepseek-flash' }] }] })
    }
    if (path === '/api/mobile/model') {
      assert.equal(method, 'PUT'); assert.ok(bots.some(b => b.id === body.bot))
      assert.equal(body.id, 'apikey:' + id(900) + ':deepseek-flash')
      state.modelWrites.push(body)
      const current = { id: body.id, kind: 'apiKey', provider: 'deepseek', modelId: 'deepseek-flash', available: true }
      state.models.set(body.bot, current)
      if (options.unknownModelWrite) throw Error('preference outcome unknown')
      return response({ current })
    }
    if (path.startsWith('/api/bots/')) {
      const botId = path.split('/').at(-1), role = roleOf(botId)
      if (method === 'GET') return response({ id: botId, publicRole: state.roles[role] })
      assert.equal(method, 'PATCH'); state.roleWrites.push({ botId, value: body.publicRole })
      state.roles[role] = body.publicRole
      if (options.unknownRoleWrite && body.publicRole !== originalRoles.Coding) {
        if (options.externalRoleChange) state.roles[role] = 'Other operator changed this fixture role.'
        throw Error('Never output this transport text or credential=private-sentinel')
      }
      return response({ ok: true })
    }
    if (path === gid + '/members') {
      if (method === 'GET') return response({ members: state.members })
      state.memberWrites.push({ method, ...body })
      if (method === 'DELETE') {
        state.members = state.members.filter(m => m.id !== body.memberId)
        if (options.unknownMemberRemoval) throw Error('unknown deletion')
      } else if (method === 'POST') {
        state.members.push({ id: body.memberId, memberType: 'bot', role: 'member' })
        if (options.unknownMemberRestore) throw Error('unknown member restoration')
      } else assert.fail('unexpected membership operation')
      return response({ ok: true })
    }
    if (path === gid + '/messages?limit=100') return response({ messages: [...state.messages].reverse(), agentStatus: null })
    if (path === gid + '/decisions?limit=100') {
      for (const turn of state.turns) state.qReads.set(turn.messageId, (state.qReads.get(turn.messageId) ?? 0) + 1)
      if (state.stopWrites) state.afterStopReads++
      if (options.lateDelegate && state.afterStopReads >= 4) state.turns[0].trace.events = state.deferredEvents
      if (options.recoverPending) for (const turn of state.turns) if (state.qReads.get(turn.messageId) >= 4) {
        turn.status = 'complete'; turn.error = null; turn.trace.status = 'complete'
      }
      return response({ turns: [...state.turns].reverse(), feedbackIsGroundTruth: false, costScope: 'routing-decision-chain' })
    }
    if (path === gid + '/stop') {
      state.stopWrites++
      for (const turn of state.turns) if (turn.status !== 'complete') {
        turn.status = 'failed'; turn.error = 'stopped'; turn.trace.status = 'stopped'
      }
      if (options.unknownStop) throw Error('unconfirmed stop PRIVATE')
      return response({ stoppedTurns: 0 })
    }
    if (path === gid + '/messages') {
      assert.equal(method, 'POST'); state.submitted++
      if (body.mentions?.length && !state.members.some(m => m.id === body.mentions[0].memberId))
        return response({ error: 'invalid_input' }, options.mentionSchema400 ? 400 : 422)
      const root = makeTurn(body.body, body.mentions, body.replyToId)
      if (options.unknownMessage && state.submitted === 1) throw Error('secret response body must not be echoed')
      return response(root, 201)
    }
    if (state.task && path === '/api/factory/tasks/' + state.task.id) {
      if (method === 'POST') {
        state.cancelWrites.push(body)
        assert.equal(body.action, 'cancel')
        assert.equal(body.binding.taskId, state.task.id)
        state.task.status = 'cancelled'; state.task.revision++; state.run.status = 'stopped'
        if (options.unknownCancel) throw Error('unconfirmed cancel PRIVATE')
      }
      if (options.epochDrift && state.cancelWrites.length) state.task.sourceEventId = id(999)
      return response({ task: state.task, attempts: [state.attempt], candidates: [] })
    }
    if (state.run && path === '/api/runs/' + state.run.id + '/evidence') return response({ run: state.run, artifacts: [], captures: [] })
    if (state.run && path === '/api/threads/' + state.run.id + '/machine') {
      state.endWrites.push(body); assert.equal(state.run.status, 'stopped'); assert.deepEqual(body, { action: 'end' })
      return response({ runId: state.run.id, state: 'ended' }, options.unknownEnd ? 404 : 200)
    }
    assert.fail('Unexpected endpoint ' + path)
  }
  const args = { owner: { request }, verifyTarget: async ({ signal }) => { assert.ok(signal instanceof AbortSignal); clock += 1; if (options.targetDrift) throw Error('private upstream drift detail') },
    assertFlashTestModel: model => assert.equal(model, 'deepseek-flash'), decisionModelId: 'openai/gpt-6-luna-decisions',
    fixture, now: () => clock, wait: async ms => { clock += ms } }
  function projection() {
    const creationReport = { status: 'pass', ...sourcePin, fixtureId, workspaceId, requesterId: ownerId, conversationId,
      startedAt: fixture.startedAt, bots: fixture.bots.map((b, i) => ({ id: bots[i].id, role: b.role, modelId: b.modelId })) }
    return { exclusive: true, coreBundleStatus: 'pass', creationReport, sourcePin, reportSha256: digest(JSON.stringify(creationReport)) }
  }
  return { args, fixture, state, bots, projection }
}

test('eight bounded messages use real protocol shapes, seven unique receipts, exact role/member restoration and safe projection', async () => {
  const h = harness(), result = await runGroupRoutingBoundaries(h.args)
  assert.equal(result.status, 'passed')
  assert.equal(result.messageAttempts, 8)
  assert.equal(result.acceptedMessages, 7)
  assert.equal(result.observedDecisionReceipts, 7)
  assert.equal(result.providerCalls.receipted, 12)
  assert.equal(result.providerCalls.retainedSteps, 12)
  assert.equal(result.providerCalls.complete, true)
  assert.ok(Math.abs(result.completeCostUsd - 0.00012) < 1e-12)
  assert.equal(result.costScope, 'routing-decision-chain')
  assert.equal(result.cases.length, 8)
  assert.equal(result.cases.at(-1).httpStatus, 422)
  assert.equal(result.cases.at(-1).noMessageOrTurnCreated, true)
  assert.deepEqual(h.state.roles, originalRoles)
  assert.equal(h.state.members.length, 4)
  assert.equal(h.state.cancelWrites.length, 0)
  assert.equal(h.state.requests.some(r => r.method === 'PUT' || r.path.includes('/dispatch')), false)
  assert.equal(h.state.roleWrites.length, 2)
  assert.deepEqual(h.state.memberWrites.map(w => w.method), ['DELETE', 'POST'])
  const output = JSON.stringify(result)
  for (const banned of ['午饭', '提交按钮', 'publicRole', 'example.invalid', 'private-sentinel']) assert.equal(output.includes(banned), false)
})

test('fixed core report projection is explicitly named, source-bound and live-owner checked; it is not a fabricated HTTP receipt', async () => {
  const h = harness(), result = await runGroupRoutingBoundaries({ ...h.args, fixture: h.projection() })
  assert.equal(result.status, 'passed')
  assert.equal(result.creationEvidence.kind, 'fixed-core-group-report-projection')
  assert.equal(Object.hasOwn(result.creationEvidence, 'httpStatus'), false)
  const bad = harness(), input = bad.projection()
  input.creationReport.requesterId = 'foreign-owner'
  const denied = await runGroupRoutingBoundaries({ ...bad.args, fixture: input })
  assert.equal(denied.status, 'failed')
  assert.equal(bad.state.requests.length, 0)
  for (const failure of ['core', 'group']) {
    const item = harness(), projected = item.projection()
    if (failure === 'core') projected.coreBundleStatus = 'fail'
    else projected.creationReport.status = 'fail'
    projected.reportSha256 = digest(JSON.stringify(projected.creationReport))
    const denied = await runGroupRoutingBoundaries({ ...item.args, fixture: projected })
    assert.equal(denied.status, 'failed')
    assert.equal(item.state.requests.length, 0)
  }
})

test('missing receipts, foreign Bot, unavailable or non-Flash selection and target drift fail before a message or mutation', async () => {
  for (const options of [{ foreignBot: true }, { unavailableModel: true }, { wrongModel: true }, { targetDrift: true }]) {
    const h = harness(options), result = await runGroupRoutingBoundaries(h.args)
    assert.equal(result.status, 'failed')
    assert.equal(h.state.requests.some(r => r.method !== 'GET'), false)
  }
  const h = harness(); h.fixture.bots[0].creationReceipt.status = 200
  const result = await runGroupRoutingBoundaries(h.args)
  assert.equal(result.status, 'failed')
  assert.equal(h.state.requests.length, 0)
})

test('a quiet reply or a wake without generation is a true case failure, never retried into a pass', async () => {
  for (const options of [{ replyOnQuiet: true }, { wakeOnQuiet: true }]) {
    const h = harness(options), result = await runGroupRoutingBoundaries(h.args)
    assert.equal(result.status, 'failed')
    assert.equal(result.cases[0].status, 'failed')
    assert.equal(h.state.submitted, 8)
    assert.equal(h.state.requests.filter(r => r.body?.body?.includes('今天午饭')).length, 1)
  }
})

test('unknown message submission and a pending turn stop the sequence without reposting or claiming silence', async () => {
  for (const options of [{ unknownMessage: true }, { pending: true }]) {
    const h = harness(options), result = await runGroupRoutingBoundaries(h.args)
    assert.equal(result.status, 'failed')
    assert.equal(h.state.submitted, 1)
    assert.equal(result.cases[0].status, 'failed')
    assert.equal(result.requiresScopeCleanup, true)
    assert.equal(h.state.cancelWrites.length, 0)
    assert.ok(result.elapsedMs <= 600_000)
  }
})

test('unknown role PATCH is read back and restored once, while an external role change is never overwritten', async () => {
  const h = harness({ unknownRoleWrite: true }), result = await runGroupRoutingBoundaries(h.args)
  assert.equal(result.status, 'failed')
  assert.equal(result.cleanup.role.restored, true)
  assert.equal(h.state.roleWrites.length, 2)
  assert.equal(h.state.roles.Coding, originalRoles.Coding)
  const foreign = harness({ unknownRoleWrite: true, externalRoleChange: true }), refused = await runGroupRoutingBoundaries(foreign.args)
  assert.equal(refused.cleanup.role.restored, false)
  assert.equal(refused.requiresScopeCleanup, true)
  assert.equal(foreign.state.roleWrites.length, 1)
  assert.equal(foreign.state.roles.Coding, 'Other operator changed this fixture role.')
})

test('unknown member writes are not retried and schema-400 cannot satisfy nonmember authorization', async () => {
  const removed = harness({ unknownMemberRemoval: true }), a = await runGroupRoutingBoundaries(removed.args)
  assert.equal(a.status, 'failed')
  assert.equal(a.cleanup.membership.restored, true)
  assert.deepEqual(removed.state.memberWrites.map(w => w.method), ['DELETE', 'POST'])
  const restored = harness({ unknownMemberRestore: true }), b = await runGroupRoutingBoundaries(restored.args)
  assert.equal(b.status, 'failed')
  assert.equal(b.cleanup.membership.restored, true)
  assert.equal(b.cleanup.membership.writeOutcome, 'unconfirmed')
  assert.equal(restored.state.memberWrites.filter(w => w.method === 'POST').length, 1)
  const malformed = harness({ mentionSchema400: true }), c = await runGroupRoutingBoundaries(malformed.args)
  assert.equal(c.status, 'failed')
  assert.equal(c.coverage.nonmemberMention, false)
  assert.equal(c.cleanup.membership.restored, true)
})

test('unexpected delegate is cancelled and ended once only after its exact runs have been observed terminal', async () => {
  const h = harness({ delegateFirst: true }), result = await runGroupRoutingBoundaries(h.args)
  assert.equal(result.status, 'failed')
  assert.equal(h.state.submitted, 1)
  assert.equal(h.state.cancelWrites.length, 1)
  assert.equal(result.cleanup.delegations[0].status, 'ended')
  assert.equal(result.cleanup.delegations[0].executionStopConfirmed, true)
  assert.equal(result.cleanup.delegations[0].machineEndAcknowledged, true)
  assert.equal(result.cleanup.delegations[0].independentProviderObservation, false)
  assert.equal(h.state.endWrites.length, 1)
  assert.equal(result.cleanup.delegations.length, 1)
  const foreign = harness({ delegateFirst: true, wrongDelegationOwner: true }), denied = await runGroupRoutingBoundaries(foreign.args)
  assert.equal(denied.status, 'failed')
  assert.equal(foreign.state.cancelWrites.length, 0)
  assert.equal(denied.requiresScopeCleanup, true)
})

test('two public replies without publish-before-next-generate ordering cannot pass the incremental case', async () => {
  const h = harness({ nonSequential: true }), result = await runGroupRoutingBoundaries(h.args)
  const dual = result.cases.find(c => c.name === 'ui-testing-incremental')
  assert.equal(result.status, 'failed')
  assert.equal(dual.status, 'failed')
  assert.equal(dual.incremental.sequential, false)
  assert.equal(h.state.submitted, 8)
})

test('expired core key needs explicit fixture-only same-Flash selection; missing option and unknown PUT never fall back or repeat', async () => {
  const blocked = harness({ expiredFixtureKey: true })
  const a = await runGroupRoutingBoundaries({ ...blocked.args, fixture: blocked.projection() })
  assert.equal(a.status, 'failed'); assert.equal(blocked.state.submitted, 0); assert.equal(blocked.state.modelWrites.length, 0)
  const h = harness({ expiredFixtureKey: true })
  const result = await runGroupRoutingBoundaries({ ...h.args, fixture: h.projection(), allowFixtureFlashSelection: true })
  assert.equal(result.status, 'passed')
  assert.equal(result.coverage.modelSelectionChanged, true)
  assert.equal(h.state.modelWrites.length, 3)
  assert.deepEqual(h.state.modelWrites.map(w => w.bot).sort(), h.bots.map(b => b.id).sort())
  assert.equal(result.fixtureModelSelections.every(r => r.availableReadback && r.httpStatus === 200), true)
  for (const options of [{ expiredFixtureKey: true, noFlashOption: true }, { expiredFixtureKey: true, unknownModelWrite: true }]) {
    const failed = harness(options)
    const evidence = await runGroupRoutingBoundaries({ ...failed.args, fixture: failed.projection(), allowFixtureFlashSelection: true })
    assert.equal(evidence.status, 'failed'); assert.equal(failed.state.submitted, 0)
    assert.ok(failed.state.modelWrites.length <= 1)
  }
})

test('recoverable pending remains inside the same120s turn budget without resubmission', async () => {
  const h = harness({ recoverPending: true }), result = await runGroupRoutingBoundaries(h.args)
  assert.equal(result.status, 'passed'); assert.equal(h.state.submitted, 8)
  assert.equal(h.state.requests.filter(r => r.body?.body?.includes('今天午饭')).length, 1)
  assert.equal(h.state.stopWrites, 1); assert.equal(result.cleanup.group.noPendingRetry, true)
})

test('a reply without its exact wake and a missing or mixed sequential chain cannot pass', async () => {
  for (const options of [{ missingWake: true }, { missingChain: true }, { mixedChain: true }]) {
    const h = harness(options), result = await runGroupRoutingBoundaries(h.args)
    assert.equal(result.status, 'failed')
  }
})

test('confirmed201 pending delegation is cleaned after timeout, including a host receipt that arrives after chat stop', async () => {
  for (const lateDelegate of [false, true]) {
    const h = harness({ pending: true, delegateFirst: true, lateDelegate }), result = await runGroupRoutingBoundaries(h.args)
    assert.equal(result.status, 'failed'); assert.equal(h.state.submitted, 1); assert.equal(h.state.stopWrites, 1)
    assert.equal(h.state.cancelWrites.length, 1); assert.equal(h.state.endWrites.length, 1)
    assert.equal(result.cleanup.group.noPendingRetry, true); assert.equal(result.cleanup.knownDelegationsReviewed, true)
    assert.equal(result.cleanup.delegations[0].executionStopConfirmed, true)
    assert.equal(result.cleanup.delegations[0].machineEndAcknowledged, true)
    assert.equal(result.cleanup.delegations[0].independentProviderObservation, false)
    const stopped = h.state.requests.findIndex(r => r.path.endsWith('/stop'))
    assert.equal(h.state.requests.slice(stopped + 1).some(r => r.path.endsWith('/messages?limit=100')), false)
    assert.equal(result.failedTurns[0].knownCostUsd, 0.00001)
  }
})

test('unknown201 is stopped at group scope but never authorizes guessing a Task or ending its VM', async () => {
  const h = harness({ unknownMessage: true, delegateFirst: true }), result = await runGroupRoutingBoundaries(h.args)
  assert.equal(result.status, 'failed'); assert.equal(h.state.submitted, 1); assert.equal(h.state.stopWrites, 1)
  assert.equal(h.state.cancelWrites.length, 0); assert.equal(h.state.endWrites.length, 0)
  assert.equal(result.cleanup.unboundDelegateObserved, true); assert.equal(result.requiresScopeCleanup, true)
  assert.equal(result.completeCostUsd, null)
})

test('foreign identity, epoch drift and unknown cleanup outcomes cannot expand or repeat scoped mutations', async () => {
  for (const [options, cancels, ends] of [[{ wrongDelegationOwner: true }, 0, 0], [{ epochDrift: true }, 1, 0],
    [{ unknownCancel: true }, 1, 1], [{ unknownEnd: true }, 1, 1]]) {
    const h = harness({ delegateFirst: true, ...options }), result = await runGroupRoutingBoundaries(h.args)
    assert.equal(result.status, 'failed'); assert.equal(h.state.cancelWrites.length, cancels); assert.equal(h.state.endWrites.length, ends)
    assert.equal(h.state.stopWrites, 1)
  }
  const h = harness({ unknownStop: true }), result = await runGroupRoutingBoundaries(h.args)
  assert.equal(result.status, 'failed'); assert.equal(h.state.stopWrites, 1)
  assert.equal(result.cleanup.group.acknowledged, false); assert.equal(result.cleanup.group.noPendingRetry, true)
})

test('a paid uncertain turn retains its actual chain and known or unknown amount after bounded pending failure', async () => {
  for (const unknownCost of [false, true]) {
    const h = harness({ invalidFirst: true, unknownCost }), result = await runGroupRoutingBoundaries(h.args)
    assert.equal(result.status, 'failed'); assert.equal(h.state.submitted, 1); assert.equal(h.state.stopWrites, 1)
    assert.equal(result.failedTurns.length, 1); assert.equal(result.failedTurns[0].decisions[0].failure, 'uncertain')
    assert.equal(result.providerCalls.receipted, 1); assert.equal(result.providerCalls.complete, false)
    assert.equal(result.knownCostUsd, unknownCost ? 0 : 0.00001)
    assert.equal(result.unknownCostCalls, unknownCost ? 1 : 0); assert.equal(result.completeCostUsd, null)
  }
})
