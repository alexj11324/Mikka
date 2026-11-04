import assert from 'node:assert/strict'
import test from 'node:test'
import { runGroupProductionAcceptance } from './group-production-acceptance.mjs'
import { randomUUID } from 'node:crypto'

const env = { MIKKA_TEST_ACCOUNT_EMAIL: 'alexjiang20232024@gmail.com', MIKKA_TEST_ACCOUNT_PASSWORD: 'synthetic-credential', GROUP_ACCEPTANCE_DEPLOYMENT: 'dpl_fixture', GROUP_ACCEPTANCE_REVISION: 'a'.repeat(40) }
const forbidden = async () => { throw Error('must not make a request') }

test('production driver requires an authorized test identity and fixed deployment before any I/O', async () => {
  await assert.rejects(runGroupProductionAcceptance({ env: {}, fetchImpl: forbidden }), /account_required/)
  await assert.rejects(runGroupProductionAcceptance({ env: { ...env, MIKKA_TEST_ACCOUNT_EMAIL: 'stranger@example.com' }, fetchImpl: forbidden }), /account_required/)
  await assert.rejects(runGroupProductionAcceptance({ env: { ...env, GROUP_ACCEPTANCE_REVISION: 'main' }, fetchImpl: forbidden }), /fixed_deployment/)
  await assert.rejects(runGroupProductionAcceptance({ env: { ...env, GROUP_ACCEPTANCE_TASK_TIMEOUT_MS: 'NaN' }, fetchImpl: forbidden }), /timeout_invalid/)
  await assert.rejects(runGroupProductionAcceptance({ env: { ...env, GROUP_ACCEPTANCE_STOP_TIMEOUT_MS: '3600000' }, fetchImpl: forbidden }), /timeout_invalid/)
  for (const origin of ['https://example.com', 'https://app.aspectlylabs.com/other', 'https://name:pass@app.aspectlylabs.com', 'https://app.aspectlylabs.com?token=x']) {
    await assert.rejects(runGroupProductionAcceptance({ env: { ...env, GROUP_ACCEPTANCE_ORIGIN: origin }, fetchImpl: forbidden }), /origin_rejected/)
  }
})

test('a moving deployment is rejected before login or fixture writes', async () => {
  const calls = []
  const result = await runGroupProductionAcceptance({ env, fetchImpl: async (url, init) => { calls.push([String(url), init.method]); return Response.json({ build: 'dpl_other' }) } })
  assert.equal(result.status, 'fail'); assert.equal(result.error, 'acceptance_deployment_changed')
  assert.deepEqual(calls, [['https://app.aspectlylabs.com/mikka/api/version', 'GET']])
})

test('a different authenticated identity is rejected and only the transient session is signed out', async () => {
  const paths = []
  const result = await runGroupProductionAcceptance({ env, fetchImpl: async url => {
    const path = new URL(url).pathname; paths.push(path)
    if (path.endsWith('/version')) return Response.json({ build: env.GROUP_ACCEPTANCE_DEPLOYMENT })
    if (path.endsWith('/sign-in/email')) return Response.json({}, { headers: { 'set-cookie': 'synthetic=session; Path=/' } })
    if (path.endsWith('/get-session')) return Response.json({ user: { email: 'someone-else@example.com' } })
    if (path.endsWith('/sign-out')) return Response.json({})
    assert.fail('must not create fixtures for the wrong identity')
  } })
  assert.equal(result.error, 'acceptance_session_identity')
  assert.equal(paths.at(-1), '/mikka/api/auth/sign-out')
  assert.ok(!JSON.stringify(result).includes('synthetic-credential'))
})

test('unavailable Flash stops before a prompt; hosted fallback is not selected and fixture IDs are retained', async () => {
  const calls = []
  let role
  const result = await runGroupProductionAcceptance({ env, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname; calls.push([path, init.method])
    if (path.endsWith('/version')) return Response.json({ build: env.GROUP_ACCEPTANCE_DEPLOYMENT })
    if (path.endsWith('/sign-in/email')) return Response.json({}, { headers: { 'set-cookie': 'synthetic=session; Path=/' } })
    if (path.endsWith('/get-session')) return Response.json({ user: { id: 'fixture-owner', email: env.MIKKA_TEST_ACCOUNT_EMAIL } })
    if (path === '/mikka/api/bots') return Response.json(init.method === 'GET' ? [{ id: 'existing', workspaceId: 'workspace' }] : { id: 'new-owned-bot', workspaceId: 'workspace' })
    if (path === '/mikka/api/bots/new-owned-bot') {
      if (init.method === 'PATCH') role = JSON.parse(init.body).publicRole
      return Response.json({ id: 'new-owned-bot', publicRole: role })
    }
    if (path.endsWith('/model')) return Response.json({ groups: [{ kind: 'hosted', options: [{ id: 'hosted', modelId: '', provider: 'mikka' }] }] })
    if (path.endsWith('/sign-out')) return Response.json({})
    assert.fail('no prompt or unrelated mutation is allowed after unavailable Flash')
  } })
  assert.equal(result.error, 'acceptance_flash_model_unavailable')
  assert.deepEqual(result.bots, [{ id: 'new-owned-bot', role: 'UI', modelId: null }])
  assert.ok(!calls.some(([path, method]) => path.endsWith('/model') && method === 'PUT'))
})

function pendingFixture({ recoverFirst = false, wrongCleanupOwner = false, unknownStop = false } = {}) {
  const ownerId = 'fixture-owner', workspaceId = randomUUID(), groupId = randomUUID()
  const bots = [], roles = new Map(), messages = [], polls = new Map(), stops = new Map(), calls = []
  let group = null, elapsed = 0, stopCalls = 0
  const receipt = { executionId: 'execution-synthetic', providerGenerationId: 'generation-synthetic',
    modelId: 'openai/gpt-6-luna-decisions', requestDigest: 'a'.repeat(64), imageDigests: [],
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }
  const step = { id: randomUUID(), phase: 'intent', index: 0, status: 'complete', failure: null, receipt, decisionCostUsd: null }
  function turn(message, index) {
    if (stops.has(message.id)) return { messageId: message.id, status: 'failed', error: 'stopped', trace: { status: 'stopped', events: [] } }
    if (index === 0 && recoverFirst && (polls.get(message.id) ?? 0) >= 2) return { messageId: message.id, status: 'complete', error: null,
      trace: { status: 'complete', action: 'ignore', responders: [], events: [], execution: receipt, policyVersion: 'group-contribution-v1',
        decisionProtocol: 'group-sequential-v1', decisions: [step], decisionsOmitted: 0 } }
    return { messageId: message.id, status: 'failed', error: index === 0 ? 'group_judgment_pending' : 'generation_failed_not_replayed',
      trace: { status: index === 0 ? 'pending' : 'failed', action: null, responders: [], events: [], execution: null, policyVersion: 'group-contribution-v1' } }
  }
  const fetchImpl = async (input, init) => {
    const url = new URL(input), path = url.pathname, body = init.body ? JSON.parse(init.body) : null
    calls.push({ path, method: init.method, afterStop: stopCalls > 0 })
    if (path.endsWith('/version')) return Response.json({ build: env.GROUP_ACCEPTANCE_DEPLOYMENT })
    if (path.endsWith('/sign-in/email')) return Response.json({}, { headers: { 'set-cookie': 'synthetic=session; Path=/' } })
    if (path.endsWith('/get-session')) return Response.json({ user: { id: group && wrongCleanupOwner ? 'foreign-owner' : ownerId, email: env.MIKKA_TEST_ACCOUNT_EMAIL } })
    if (path.endsWith('/sign-out')) return Response.json({})
    if (path === '/mikka/api/bots') {
      if (init.method === 'GET') return Response.json([{ id: randomUUID(), workspaceId, ownerId }, ...bots])
      const bot = { id: randomUUID(), ownerId, workspaceId, name: body.name }; bots.push(bot)
      return Response.json(bot, { status: 201 })
    }
    if (/^\/mikka\/api\/bots\/[^/]+$/.test(path)) {
      const id = path.split('/').at(-1)
      if (init.method === 'PATCH') roles.set(id, body.publicRole)
      return Response.json({ id, publicRole: roles.get(id) })
    }
    if (path.endsWith('/mobile/model')) return Response.json({ current: { modelId: 'deepseek-flash', available: true },
      groups: [{ kind: 'apiKey', options: [{ id: 'apikey:synthetic:deepseek-flash', provider: 'deepseek', modelId: 'deepseek-flash' }] }] })
    if (path === '/mikka/api/conversations') {
      if (init.method === 'GET') return Response.json({ conversations: group ? [group] : [] })
      group = { id: groupId, title: body.title, workspaceId, createdBy: ownerId, kind: 'group', createdAt: new Date().toISOString() }
      return Response.json({ id: groupId, title: body.title }, { status: 201 })
    }
    if (path.endsWith('/members')) return Response.json({ members: [{ id: ownerId, memberType: 'user', role: 'owner' },
      ...bots.map(bot => ({ id: bot.id, memberType: 'bot', role: 'member' }))] })
    if (path.endsWith('/messages')) {
      if (init.method === 'GET') return Response.json({ messages })
      const message = { id: randomUUID(), authorType: 'user', authorId: ownerId, body: body.body, replyToId: null }
      messages.push(message); return Response.json(message, { status: 201 })
    }
    if (path.endsWith('/decisions')) {
      for (const message of messages) polls.set(message.id, (polls.get(message.id) ?? 0) + 1)
      return Response.json({ turns: messages.map(turn), feedbackIsGroundTruth: false, costScope: 'routing-decision-chain' })
    }
    if (path.endsWith('/stop')) {
      stopCalls++
      assert.equal(init.method, 'POST'); assert.deepEqual(body, {})
      let changed = 0
      for (let i = 0; i < messages.length; i++) {
        const current = turn(messages[i], i)
        if (['queued','running'].includes(current.status) || current.error === 'group_judgment_pending') { stops.set(messages[i].id, true); changed++ }
      }
      if (unknownStop) throw Error('unknown stop transport outcome')
      return Response.json({ stopped: changed })
    }
    assert.fail('Unexpected endpoint in isolated transport fixture')
  }
  return { calls, messages, stopCount: () => stopCalls, elapsed: () => elapsed,
    run: () => runGroupProductionAcceptance({ env, fetchImpl, now: () => elapsed, wait: async ms => { elapsed += ms } }) }
}

test('pending judgment can finish within the original budget but never passes as silence while pending', async () => {
  const f = pendingFixture({ recoverFirst: true }), report = await f.run()
  assert.equal(report.cases[0].status, 'pass')
  assert.equal(report.cases[0].wakes, 0)
  assert.equal(report.cases[0].decision.providerGenerationId, 'generation-synthetic')
  assert.equal(report.cases[0].decisions.length, 1)
  assert.deepEqual(report.cases[0].decisionCalls, { attempted: 1, receipted: 1, unreceipted: 0 })
  assert.equal(report.cases[0].decisionCostUsd, null)
  assert.equal(report.decisionObservations[0].decisionCostUsd, null)
  assert.ok(f.elapsed() >= 1000 && f.elapsed() < 120000)
  assert.equal(report.status, 'fail', 'the later failed turn must remain a failure')
  assert.equal(f.stopCount(), 1)
  assert.equal(report.groupCleanup.noPendingRetry, true)
  assert.equal(report.sessionEnded, true)
  assert.ok(!f.calls.some(call => call.afterStop && call.path.endsWith('/messages')))
})

test('a permanently pending judgment times out and stops only the newly created owner fixture once', async () => {
  const f = pendingFixture(), report = await f.run()
  assert.equal(report.status, 'fail')
  assert.equal(report.error, 'acceptance_turn_timeout')
  assert.equal(report.cases[0].status, 'fail')
  assert.equal(f.elapsed(), 120000)
  assert.equal(f.messages.length, 1)
  assert.equal(f.stopCount(), 1)
  assert.equal(report.groupCleanup.acknowledged, true)
  assert.equal(report.groupCleanup.stoppedTurns, 1)
  assert.equal(report.groupCleanup.noPendingRetry, true)
  assert.equal(report.groupCleanup.executionStopConfirmed, false)
  assert.equal(report.sessionEnded, true)
})

test('cleanup refuses a changed owner; an unknown stop is observed without another write', async () => {
  const foreign = pendingFixture({ wrongCleanupOwner: true }), denied = await foreign.run()
  assert.equal(foreign.stopCount(), 0)
  assert.equal(denied.groupCleanup.error, 'acceptance_group_cleanup_owner')
  assert.equal(denied.sessionEnded, true)
  const unknown = pendingFixture({ unknownStop: true }), observed = await unknown.run()
  assert.equal(unknown.stopCount(), 1)
  assert.equal(observed.groupCleanup.status, 'stop-observed-unconfirmed')
  assert.equal(observed.groupCleanup.noPendingRetry, true)
  assert.equal(observed.groupCleanup.acknowledged, false)
  assert.equal(observed.sessionEnded, true)
})
