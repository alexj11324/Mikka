import assert from 'node:assert/strict'
import test from 'node:test'
import { ALEX_OWNER_ID } from '../issue-1506-readonly/alex-session.mjs'
import { privateGenerationReceipt, runGroupStop, validateGroupMembers } from './group-stop.mjs'
import { openGroupLive } from './group-live.mjs'
import { fakeSession, fixtureReceipt, PRIVATE, WORKSPACE_ID, BOT_IDS } from './fixture-support.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }
const GROUP_ID = '55555555-5555-4555-8555-555555555555'
const MESSAGE_ID = '66666666-6666-4666-8666-666666666666'
const LINK_ID = '77777777-7777-4777-8777-777777777777'

function fixture({ lostSend = false, boundaryTimeout = false, extraMember = false, liveFailure = false, afterActive = false,
  allowCleanup = false, privateScenario = false, missingPrivateGenerate = false, targetKey = 'haiku' } = {}) {
  const base = fakeSession({ readyBots: true })
  const targetId = BOT_IDS[targetKey === 'haiku' ? 0 : 1], leadId = privateScenario ? BOT_IDS.find(id => id !== targetId) : targetId
  const state = { creates: 0, sends: 0, stops: 0, reads: 0, decisionReads: 0, boundaryDecisionReads: 0,
    removed: [], hidden: false, liveNext: 0, liveClosed: false }
  let group = null, message = null, stopped = false, members = [...BOT_IDS]
  const provider = (work, options) => base.provider(session => work({ ...session,
    async request(path, input = {}) {
      const route = path.split('?')[0]
      let value
      if (route === '/api/conversations') {
        if (input.body) {
          state.creates++; assert.equal(state.creates, 1)
          assert.equal(input.body.workspaceId, WORKSPACE_ID); assert.equal(input.body.leadBotId, leadId)
          assert.deepEqual(input.body.members, BOT_IDS.map(memberId => ({ memberType: 'bot', memberId })))
          group = { id: GROUP_ID, title: input.body.title, kind: 'group', createdBy: ALEX_OWNER_ID, workspaceId: WORKSPACE_ID, leadBotId: leadId }
          value = { id: GROUP_ID, title: group.title, leadBotId: leadId }
        } else {
          assert.equal(path, '/api/conversations?workspaceId=' + WORKSPACE_ID)
          value = { viewerId: ALEX_OWNER_ID, workspaceId: WORKSPACE_ID, conversations: group ? [group] : [] }
        }
      } else if (route === `/api/conversations/${GROUP_ID}/members`) {
        if (input.method === 'DELETE') {
          assert.equal(input.body.memberType, 'bot'); assert.ok(BOT_IDS.includes(input.body.memberId))
          state.removed.push(input.body.memberId); members = members.filter(id => id !== input.body.memberId); value = { ok: true }
        } else value = { members: [{ id: ALEX_OWNER_ID, memberType: 'user', role: 'owner', name: PRIVATE },
          ...members.map(id => ({ id, memberType: 'bot', name: PRIVATE })),
          ...(extraMember ? [{ id: PRIVATE, memberType: 'user', role: 'member' }] : [])] }
      } else if (route === `/api/conversations/${GROUP_ID}/messages`) {
        if (input.body) {
          state.sends++; assert.equal(state.sends, 1)
          assert.deepEqual(input.body.mentions, [{ memberType: 'bot', memberId: leadId }])
          if (privateScenario) assert.ok(input.body.body.includes(targetId))
          message = { id: MESSAGE_ID, position: '1', conversationId: GROUP_ID, authorType: 'user', authorId: ALEX_OWNER_ID, body: input.body.body }
          if (lostSend) throw new Error(PRIVATE)
          value = message
        } else {
          state.reads++; value = { messages: message ? [message] : [], leadBotId: leadId, revision: stopped ? 3 : message ? 2 : 1,
            timeline: message && privateScenario ? [{ type: 'agent_exchange', linkId: LINK_ID, anchorPosition: '1', count: '1',
              participants: BOT_IDS.map(id => ({ id, memberType: 'bot', name: PRIVATE })) }] : [],
            agentStatus: message && (!stopped || afterActive) ? { status: 'running', botId: targetId, agentId: null } : null,
            stopped, private: PRIVATE }
        }
      } else if (route === `/api/conversations/${GROUP_ID}/stop`) {
        state.stops++; assert.ok(state.stops <= (allowCleanup ? 2 : 1)); assert.deepEqual(input.body, {})
        value = { stopped: message && !stopped ? 1 : 0 }; stopped = true
      } else if (route === `/api/conversations/${GROUP_ID}/decisions`) {
        state.decisionReads++; if (!stopped) state.boundaryDecisionReads++
        value = { turns: [{ messageId: MESSAGE_ID, status: stopped ? 'failed' : 'running', error: stopped ? 'stopped' : null,
          trace: { status: stopped ? 'stopped' : 'pending', context: PRIVATE,
            events: [{ type: 'wake', memberId: leadId }, { type: 'generate', memberId: leadId },
              ...(privateScenario ? [{ type: 'private_publish', memberId: leadId },
                ...(!missingPrivateGenerate ? [{ type: 'generate', memberId: targetId }] : [])] : [])] },
          feedback: stopped ? [{ source: 'human_cancellation', kind: 'cancelled_turn', private: PRIVATE }] : [] }] }
      }
      else if (route === `/api/mobile/groups/${GROUP_ID}`) { assert.equal(input.method, 'PATCH'); assert.deepEqual(input.body, { hidden: true }); state.hidden = true; value = { ok: true } }
      else return session.request(path, input)
      session.requests.push({ path: '/mikka' + route, method: input.method ?? (input.body ? 'POST' : 'GET'), status: 200, headersMs: 0 })
      return Response.json(value)
    } }), options)
  const openLive = async () => {
    if (liveFailure) throw new Error('live_not_supported')
    const summary = { ready: true, revisionCapable: true, matchingPushes: 1, maxRevision: 2, readsTriggered: 0, closed: false }
    return { summary, async next(after) { state.liveNext++; assert.equal(after, 1); if (boundaryTimeout) throw new Error('group_boundary_timeout'); return 2 },
      async close() { state.liveClosed = true; summary.closed = true; return true } }
  }
  return { state, base: base.state, options: { env: { ...base.options.env, MIKKA_FIXTURE_KIND: targetKey,
    MIKKA_GROUP_STOP_SCENARIO: privateScenario ? 'private' : 'public' }, fixtureReceipt: fixtureReceipt(),
    sessionProvider: provider, openLive, checkpoint: false, boundaryTimeoutMs: 30 } }
}

test('new group has only this owner and the two test bots; a real revision causes one responding-state read and one stop', async () => {
  const f = fixture(), report = await runGroupStop(f.options)
  assert.equal(report.status, 'stop_evidence_captured', JSON.stringify(report))
  assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1); assert.equal(f.state.liveNext, 1)
  assert.equal(report.liveReads.length, 1); assert.equal(report.postStopReads, 1)
  assert.equal(report.turn.generateEntries, 1); assert.equal(report.turn.humanCancellationRecorded, true)
  assert.equal(report.runtimeCancellation, 'pending_provider_logs')
  assert.deepEqual(f.state.removed, []); assert.equal(f.state.hidden, false); assert.equal(f.state.liveClosed, true)
  assert.equal(report.cleanup.status, 'retained_for_provider_audit'); assert.equal(report.cleanup.retainedForProviderAudit, true)
  assert.deepEqual(report.cleanup.retainedBotIds, BOT_IDS)
  assert.equal(report.lateSideEffects, 'pending_provider_terminal_and_one_database_audit')
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('after-send stop labels its observed boundary honestly and performs no status polling', async () => {
  const f = fixture(), report = await runGroupStop({ ...f.options, env: { ...f.options.env, MIKKA_GROUP_STOP_BOUNDARY: 'after_send' } })
  assert.equal(report.status, 'stop_evidence_captured'); assert.equal(report.stop.trigger, 'send_acknowledged')
  assert.equal(f.state.liveNext, 0); assert.equal(report.liveReads.length, 0); assert.equal(report.postStopReads, 1)
})

test('lost send acknowledgement is never resubmitted; stop and one final read recover only this own message', async () => {
  const f = fixture({ lostSend: true }), report = await runGroupStop(f.options)
  assert.equal(report.status, 'failed'); assert.equal(report.error, 'group_send_unknown')
  assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1); assert.equal(report.postStopReads, 1)
  assert.equal(report.messageId, MESSAGE_ID); assert.equal(report.sendOutcome, 'read_after_unknown_no_retry')
  assert.equal(f.state.hidden, false); assert.deepEqual(f.state.removed, [])
  assert.equal(report.cleanup.retainedForProviderAudit, true); assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('a missed live boundary stops once without retries and retains the failure', async () => {
  const f = fixture({ boundaryTimeout: true }), report = await runGroupStop(f.options)
  assert.equal(report.status, 'failed'); assert.equal(report.error, 'group_boundary_timeout')
  assert.equal(f.state.liveNext, 1); assert.equal(f.state.stops, 1); assert.equal(report.postStopReads, 1)
  assert.equal(f.state.hidden, false); assert.deepEqual(f.state.removed, [])
  assert.equal(report.cleanup.retainedForProviderAudit, true)
})

test('unexpected human members receive no test message and prevent scoped cleanup writes', async () => {
  const f = fixture({ extraMember: true }), report = await runGroupStop(f.options)
  assert.equal(report.error, 'group_member_mismatch'); assert.equal(f.state.sends, 0); assert.equal(f.state.stops, 0)
  assert.equal(f.state.hidden, false); assert.equal(f.state.removed.length, 0)
  assert.throws(() => validateGroupMembers({ members: [{ id: ALEX_OWNER_ID, memberType: 'user', role: 'owner' },
    { id: 'foreign', memberType: 'agent' }] }, BOT_IDS), /group_member_mismatch/)
})

test('failed live readiness cleans up an empty owned group without sending or stopping', async () => {
  const f = fixture({ liveFailure: true }), report = await runGroupStop(f.options)
  assert.equal(report.error, 'live_not_supported'); assert.equal(f.state.sends, 0); assert.equal(f.state.stops, 0)
  assert.equal(f.state.hidden, true); assert.deepEqual(f.state.removed, BOT_IDS)
})

test('an active state after stop remains needs-followup; no repeated read or member removals can hide it', async () => {
  const f = fixture({ afterActive: true }), report = await runGroupStop(f.options)
  assert.equal(report.error, 'group_cleanup_pending'); assert.equal(report.cleanup.status, 'needs_followup')
  assert.equal(report.postStopReads, 1); assert.equal(f.state.stops, 1); assert.equal(f.state.hidden, false); assert.equal(f.state.removed.length, 0)
})

test('independent cleanup revalidates the retained exact group and removes members only in the explicit cleanup invocation', async () => {
  const f = fixture({ allowCleanup: true }), observed = await runGroupStop(f.options)
  assert.equal(observed.status, 'stop_evidence_captured')
  assert.equal(observed.cleanup.status, 'retained_for_provider_audit'); assert.deepEqual(f.state.removed, [])
  const report = await runGroupStop({ ...f.options, mode: 'cleanup', groupReceipt: observed,
    env: { MIKKA_ACCEPTANCE_SHA: 'b'.repeat(40) } })
  assert.equal(report.status, 'cleanup_complete', JSON.stringify(report))
  assert.equal(f.state.creates, 1); assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 2)
  assert.deepEqual(f.state.removed, BOT_IDS); assert.equal(report.postStopReads, 1)
  assert.equal(report.cleanup.hidden, true)
})

for (const targetKey of ['haiku', 'luna']) test(`private ${targetKey} case waits for its own linked exchange and host generate receipt, then retains both members`, async () => {
  const f = fixture({ privateScenario: true, targetKey }), report = await runGroupStop(f.options)
  assert.equal(report.status, 'stop_evidence_captured', JSON.stringify(report))
  assert.equal(report.scenario, 'private'); assert.equal(report.boundary, 'private_generation_receipt')
  assert.equal(report.privateBoundary.linkId, LINK_ID); assert.equal(report.privateBoundary.privateMessagesBeforeStop, 1)
  assert.equal(report.privateBoundary.targetBotId, BOT_IDS[targetKey === 'haiku' ? 0 : 1])
  assert.equal(report.privateBoundary.providerInFlight, 'requires_start_end_log_correlation')
  assert.equal(report.stop.trigger, 'private_generate_receipt'); assert.equal(f.state.stops, 1)
  assert.equal(f.state.boundaryDecisionReads, 1); assert.equal(f.state.decisionReads, 2)
  assert.equal(report.turn.generateEntries, 2); assert.equal(report.turn.privatePublishes, 1); assert.equal(report.turn.publicPublishes, 0)
  assert.equal(report.postStopReads, 1); assert.equal(f.state.liveNext, 1)
  assert.equal(report.cleanup.status, 'retained_for_provider_audit'); assert.deepEqual(f.state.removed, []); assert.equal(f.state.hidden, false)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('private responder state without the host generate receipt fails, stops once, and does not poll decisions or dismantle membership', async () => {
  const f = fixture({ privateScenario: true, missingPrivateGenerate: true }), report = await runGroupStop(f.options)
  assert.equal(report.status, 'failed'); assert.equal(report.error, 'group_private_generation_not_observed')
  assert.equal(report.privateBoundary, undefined); assert.equal(f.state.stops, 1)
  assert.equal(f.state.boundaryDecisionReads, 1); assert.equal(f.state.decisionReads, 2)
  assert.equal(f.state.liveNext, 1); assert.equal(report.postStopReads, 1)
  assert.equal(report.cleanup.retainedForProviderAudit, true); assert.deepEqual(f.state.removed, [])
})

test('private generation receipt rejects a public-only turn, wrong recipient, or completed output', () => {
  const events = [{ type: 'generate', memberId: BOT_IDS[0] }, { type: 'private_publish', memberId: BOT_IDS[0] },
    { type: 'generate', memberId: BOT_IDS[1] }]
  const trace = rows => ({ turns: [{ messageId: MESSAGE_ID, status: 'running', error: null, trace: { status: 'pending', events: rows } }] })
  assert.equal(privateGenerationReceipt(trace(events), MESSAGE_ID, BOT_IDS[0], BOT_IDS[1]).targetGenerateRecorded, true)
  for (const rows of [events.slice(0, 1), events.slice(0, 2), [...events, { type: 'private_publish', memberId: BOT_IDS[1] }],
    [...events, { type: 'publish', memberId: BOT_IDS[1] }], [...events, { type: 'delegate', memberId: BOT_IDS[1] }]]) {
    assert.throws(() => privateGenerationReceipt(trace(rows), MESSAGE_ID, BOT_IDS[0], BOT_IDS[1]), /group_private_generation_not_observed/)
  }
  assert.throws(() => privateGenerationReceipt(trace(events), MESSAGE_ID, BOT_IDS[1], BOT_IDS[0]), /group_private_generation_not_observed/)
})

test('group live observer accepts only versioned matching UUID events and closes without a reconnect', async () => {
  let socket
  class Socket extends EventTarget {
    readyState = 1
    constructor() { super(); socket = this; queueMicrotask(() => this.packet({ type: 'live_ready', version: 2, kinds: ['group_chat'], revisions: ['group_chat'] })) }
    packet(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })) }
    send(value) { assert.equal(value, 'ping') }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  const session = { identity: { userId: ALEX_OWNER_ID }, async request(path) {
    assert.equal(path, '/api/live/ticket?workspace=' + WORKSPACE_ID)
    return Response.json({ url: 'wss://live.example.test/v1/live/' + 'a'.repeat(64) + '/socket', protocol: PRIVATE, expiresAt: Date.now() + 30_000 })
  } }
  const live = await openGroupLive(session, WORKSPACE_ID, GROUP_ID, 1, { WebSocketClass: Socket })
  socket.packet({ kind: 'group_chat', id: 123, rev: 2 })
  socket.packet({ kind: 'group_chat', id: BOT_IDS[0], rev: 2 })
  assert.equal(live.summary.matchingPushes, 0)
  const change = live.next(1, 30)
  socket.packet([{ kind: 'group_chat', id: GROUP_ID, rev: 2 }])
  assert.equal(await change, 2); assert.equal(live.summary.matchingPushes, 1)
  assert.equal(await live.close(), true); assert.equal(live.summary.closed, true)
})
