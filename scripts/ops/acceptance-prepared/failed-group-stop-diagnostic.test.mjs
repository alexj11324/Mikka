import test from 'node:test'
import assert from 'node:assert/strict'
import { FIXED, runFailedGroupStop } from './failed-group-stop-diagnostic.mjs'

function fixture(options = {}) {
  const email = 'test+mikka-smoke@example.invalid', password = 'synthetic-password-only'
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka',
    GITHUB_REF: 'refs/heads/acceptance/proactive-1157-1163', GITHUB_EVENT_NAME: 'push',
    GROUP_STOP_REVISION: FIXED.revision, GROUP_STOP_DEPLOYMENT: FIXED.deploymentId,
    SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: password }
  const calls = [], base = '/api/conversations/' + FIXED.conversationId
  let stopped = false, versions = 0
  const json = (body, headers) => new Response(JSON.stringify(body), { status: 200, headers })
  const page = () => ({ costScope: 'primary-routing-decision-api', feedbackIsGroundTruth: false, turns: [{
    messageId: options.wrongMessage ? '00000000-0000-4000-8000-000000000001' : FIXED.messageId,
    status: 'failed', error: stopped ? 'stopped' : 'group_judgment_pending', decisionCostUsd: null,
    feedback: [{ private: 'private-sentinel' }], trace: { schemaVersion: 1, policyVersion: 'group-contribution-v1',
      status: stopped ? 'stopped' : 'pending', action: null, reason: 'private-sentinel', execution: null,
      responders: [], events: [], members: [], contextMessageIds: [], privatePayload: { password } },
  }] })
  const fetchImpl = async (input, init) => {
    const u = new URL(input)
    assert.equal(u.origin, FIXED.origin); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal)
    const path = u.pathname.slice('/mikka'.length) + u.search
    calls.push({ path, method: init.method, body: init.body && JSON.parse(init.body) })
    assert.equal(/\/messages|\/replay|api-keys|e2b-key|\/mobile\/model/.test(path), false)
    if (path === '/api/version') return json({ build: options.driftBeforeStop && ++versions === 2 ? 'dpl_Drift' : FIXED.deploymentId })
    if (path === '/api/auth/sign-in/email') return json({ user: { id: FIXED.requesterId } }, { 'set-cookie': 'session=synthetic-session-only; Path=/; HttpOnly' })
    if (path === '/api/auth/get-session') return json({ user: { id: options.foreignOwner ? 'other-owner' : FIXED.requesterId, email } })
    if (path === '/api/auth/sign-out') return json({ success: true })
    if (path === '/api/conversations?workspaceId=' + FIXED.workspaceId) return json({ conversations: [{
      id: FIXED.conversationId, createdBy: FIXED.requesterId, workspaceId: FIXED.workspaceId, kind: 'group',
      title: 'Proactive acceptance 1234abcd', createdAt: '2026-11-04T02:40:00Z',
    }] })
    if (path === '/api/bots') return json(FIXED.botIds.map((id, i) => ({ id, ownerId: FIXED.requesterId,
      workspaceId: FIXED.workspaceId, name: 'Acceptance ' + ['UI', 'Coding', 'Testing'][i] + ' 1234abcd' })))
    if (path === base + '/members') return json({ members: [
      { id: FIXED.requesterId, memberType: 'user', role: 'owner' },
      ...FIXED.botIds.map(id => ({ id, memberType: 'bot', role: 'member' })),
      ...(options.extraMember ? [{ id: 'other', memberType: 'user', role: 'member' }] : []),
    ] })
    if (path === base + '/decisions?limit=100') return json(page())
    if (path === base + '/stop') {
      assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), {})
      stopped = true
      if (options.unknownStop) throw Error('private upstream body must not escape')
      return json({ stopped: 1 })
    }
    assert.fail('unexpected endpoint')
  }
  return { calls, args: { env, fetchImpl, accountValidator: value => value === email, verifySource: () => FIXED.revision } }
}

test('exact failed fixture is stopped once with safe before/after projection and normal logout; null cost is not zero', async () => {
  const f = fixture(), report = await runFailedGroupStop(f.args)
  assert.equal(report.status, 'passed')
  assert.equal(report.stop.recorded, true); assert.equal(report.stop.noPendingRetry, true)
  assert.equal(report.stop.executionStopConfirmed, false)
  assert.equal(report.cleanup.logoutAcknowledged, true)
  assert.equal(report.before.turns[0].decisionCostUsd, null)
  assert.equal(report.before.turns[0].trace.receipt, null)
  assert.equal(report.limitations.absentReceiptDoesNotProveNoInvocation, true)
  assert.equal(report.counts.get, 9); assert.equal(report.counts.post, 3)
  assert.equal(f.calls.filter(c => c.path.endsWith('/stop')).length, 1)
  for (const secret of ['private-sentinel', 'synthetic-password-only', 'synthetic-session-only', 'example.invalid', 'Proactive acceptance'])
    assert.equal(JSON.stringify(report).includes(secret), false)
  assert.equal(report.failedCore.revision, '8c94364458632edb2964e54f0a478bb70fedbbd5')
  assert.equal(report.revision, '7b212367026f090907f724b618743ae63f7fa68a')
})

test('foreign owner, extra member or unexpected turn refuse stop and still log out; wrong workflow sends no requests', async () => {
  for (const options of [{ foreignOwner: true }, { extraMember: true }, { wrongMessage: true }]) {
    const f = fixture(options), report = await runFailedGroupStop(f.args)
    assert.equal(report.status, 'failed')
    assert.equal(f.calls.filter(c => c.path.endsWith('/stop')).length, 0)
    assert.equal(report.cleanup.logoutAcknowledged, true)
  }
  const f = fixture(); f.args.env.GITHUB_EVENT_NAME = 'workflow_dispatch'
  await assert.rejects(runFailedGroupStop(f.args), /group_stop_workflow_scope/)
  assert.equal(f.calls.length, 0)
})

test('unknown stop is read back without retry; deployment drift before mutation stops the write', async () => {
  const f = fixture({ unknownStop: true }), report = await runFailedGroupStop(f.args)
  assert.equal(report.status, 'failed')
  assert.equal(report.stop.recorded, true)
  assert.equal(report.stop.acknowledged, false)
  assert.equal(report.cleanup.logoutAcknowledged, true)
  assert.equal(f.calls.filter(c => c.path.endsWith('/stop')).length, 1)
  const drift = fixture({ driftBeforeStop: true }), other = await runFailedGroupStop(drift.args)
  assert.equal(other.status, 'failed')
  assert.equal(drift.calls.filter(c => c.path.endsWith('/stop')).length, 0)
  assert.equal(other.cleanup.logoutAcknowledged, true)
})
