import assert from 'node:assert/strict'
import test from 'node:test'
import { observeGroupStop, verifyMembers, verifyAudit } from './group-stop-production.mjs'
import { createHash } from 'node:crypto'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const ownerId = 'synthetic-smoke-owner', scope = { ownerId, workspaceId: id(1) }
const bots = [{ id: id(2), harness: 'claude_code' }, { id: id(3), harness: 'claude_code' }]
const binding = { applicationSha: 'a'.repeat(40), runId: '12345' }
const members = () => ({ members: [{ id: ownerId, memberType: 'user', role: 'owner' }, ...bots.map(bot => ({ id: bot.id, memberType: 'bot' }))] })

function fixture(scenario, options = {}) {
  let sent = false, stopped = false, stopCalls = 0, readCalls = 0, title
  const message = { id: id(5), position: '1', conversationId: id(4), authorId: ownerId, authorType: 'user' }
  const client = {
    async rpc(action, args) {
      assert.equal(action, 'execution-settings.getBotModelMenu'); assert.ok(bots.some(bot => bot.id === args[0]))
      return { current: { kind: 'subscription', modelId: options.wrongModel ? 'claude-opus-forbidden' : 'claude-haiku-5-5', provider: 'claude', chosen: true } }
    },
    async json(path, init) {
      if (path === '/api/version') return { build: binding.applicationSha }
      if (path === '/api/conversations') { title = JSON.parse(init.body).title; return { id: id(4), title, leadBotId: id(2) } }
      if (path.endsWith('/members')) return members()
      if (path.endsWith('/stop')) { stopCalls++; if(options.failedStopBeforeCommit&&stopCalls===1)throw Error('PRIVATE_PROVIDER_BODY'); stopped = true; return { stopped: 1 } }
      if (path.includes('/messages')) {
        if (init) { sent = true; if (options.lostSend) throw Error('PRIVATE_PROVIDER_BODY'); return message }
        readCalls++
        return { messages: sent ? [message] : [], revision: sent ? 2 : 1, stopped,
          agentStatus: sent && !stopped && !options.earlyTerminal ? { status: 'running', botId: scenario === 'private' ? id(3) : id(2) } : null,
          timeline: scenario === 'private' && sent ? [{ type: 'agent_exchange', linkId: id(6), anchorPosition: '1', count: '1',
            participants: bots.map(bot => ({ memberType: 'bot', id: bot.id })) }] : [] }
      }
      if (path.includes('/decisions')) return { turns: [{ messageId: id(5), status: stopped ? 'failed' : 'running', error: stopped ? 'stopped' : null,
        trace: { status: stopped ? 'stopped' : 'pending', events: [
          { type: 'generate', memberId: id(2) }, ...(scenario === 'private' ? [{ type: 'private_publish', memberId: id(2) },
            ...(options.missingPrivateGeneration ? [] : [{ type: 'generate', memberId: id(3) }])] : [])] },
        feedback: stopped ? [{ source: 'human_cancellation', kind: 'cancelled_turn' }] : [] }] }
      assert.fail('unexpected URL')
    },
  }
  const checkpoints = []
  const openLive = async () => ({ summary: { matchingPushes: 1 }, async next(after) { assert.equal(after, 1); return 2 }, async close() { return true } })
  return { client, openLive, checkpoints, checkpoint: async row => { checkpoints.push(structuredClone(row)) }, state: () => ({ stopCalls, readCalls, sent, stopped, title }) }
}

test('group membership refuses other users, duplicate bots and an unexpected third bot', () => {
  verifyMembers(members(), ownerId, bots.map(bot => bot.id))
  for (const value of [
    { members: [...members().members, { memberType: 'user', id: 'foreign' }] },
    { members: [members().members[0], members().members[1], members().members[1]] },
    { members: [members().members[0], members().members[1], { memberType: 'bot', id: id(99) }] },
  ]) assert.throws(() => verifyMembers(value, ownerId, bots.map(bot => bot.id)), /group_member_scope/)
})

test('both public and actual private-generation boundaries use push, Stop, one post-stop read and retain membership for runtime audit', async () => {
  for (const scenario of ['public', 'private']) {
    const f = fixture(scenario), report = await observeGroupStop(f.client, scope, bots, scenario, binding, f)
    assert.equal(report.status, 'stop_evidence_captured', JSON.stringify(report))
    assert.equal(report.liveReads, 1); assert.equal(f.state().readCalls, 3); assert.equal(f.state().stopCalls, 1)
    assert.equal(report.acceptancePassed, undefined); assert.equal(report.cleanup.membershipRetainedForAudit, true)
    assert.equal(report.humanCancellationRecorded, true); assert.equal(report.cleanup.liveClosed, true)
    assert.ok(f.checkpoints.some(row => row.groupId === id(4) && !row.sentAt), 'owned group is journaled before sending')
    assert.ok(f.checkpoints.some(row => row.sentAt && row.messageId === null), 'uncertain send is recoverable')
    if (scenario === 'private') assert.equal(report.privateBoundary.targetGenerateRecorded, true)
  }
})

test('a private message without a target-generation receipt and an early terminal cannot pass; both stop owned work', async () => {
  for (const options of [{ missingPrivateGeneration: true }, { earlyTerminal: true }]) {
    const f = fixture('private', options), report = await observeGroupStop(f.client, scope, bots, 'private', binding, f)
    assert.equal(report.status, 'failed'); assert.equal(f.state().stopCalls, 1)
    assert.equal(report.afterStop.active, false); assert.equal(report.cleanup.liveClosed, true)
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PROVIDER_BODY/)
  }
})

test('a lost send acknowledgement never retries the message and recovers its owned receipt only for cleanup', async () => {
  const f = fixture('public', { lostSend: true }), report = await observeGroupStop(f.client, scope, bots, 'public', binding, f)
  assert.equal(report.status, 'failed'); assert.equal(f.state().stopCalls, 1)
  assert.equal(report.messageId, id(5)); assert.equal(report.messageReceipt, 'recovered_once_after_unknown_send')
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PROVIDER_BODY/)
})

test('a changed native model stops before creating a group or sending a prompt', async () => {
  const f = fixture('public', { wrongModel: true }), report = await observeGroupStop(f.client, scope, bots, 'public', binding, f)
  assert.equal(report.error, 'group_subscription_changed'); assert.equal(f.state().title, undefined)
  assert.equal(f.state().sent, false); assert.equal(f.state().stopCalls, 0)
})

test('a lost Stop response with a still-active owned group is recovered once, while acceptance remains failed',async()=>{
  const f=fixture('public',{failedStopBeforeCommit:true}),report=await observeGroupStop(f.client,scope,bots,'public',binding,f)
  assert.equal(report.status,'failed');assert.equal(f.state().stopCalls,2)
  assert.equal(report.cleanup.stopRecoveredAfterActiveRead,true);assert.equal(report.afterStop.active,false)
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_PROVIDER_BODY/)
})

test('cleanup refuses foreign ownership, unsettled server work and a missing or repeated database audit', () => {
  const artifact = { schemaVersion: 1, issue: 1212, case: 'shared-smoke-group-stop', binding, workspaceId: scope.workspaceId,
    ownerRef: createHash('sha256').update(ownerId).digest('hex').slice(0, 16),
    bots: bots.map((bot, i) => ({ ...bot, name: 'Issue1212 Stop 12345 claude_code ' + i })),
    cases: [{ groupId: id(4), messageId: id(5), title: 'Issue1212 Stop 12345 public fixture' }] }
  const proof = { groupId: id(4), messageId: id(5), serverTerminal: true, started: 2, settled: 2, aborted: 1,
    sessionLost: false, databaseAuditPassed: true, databaseSelectCount: 1,
    statementSha256: 'cddb79788d85ed13c6b7df82adcd0f471f94bbba6fa73c6576ca1643c2907c6c', terminalReceiptSha256: 'c'.repeat(64) }
  const audit = { sourceRunId: binding.runId, sourceSha: binding.applicationSha, deploymentId: 'dpl_fixture', groups: [proof] }
  verifyAudit(artifact, audit, ownerId)
  assert.throws(() => verifyAudit(artifact, audit, 'foreign'), /cleanup_artifact_scope/)
  for (const change of [{ settled: 1 }, { serverTerminal: false }, { aborted: 0 }, { sessionLost: true },
    { databaseSelectCount: 2 }, { databaseAuditPassed: false }, { statementSha256: 'd'.repeat(64) }]) {
    assert.throws(() => verifyAudit(artifact, { ...audit, groups: [{ ...proof, ...change }] }, ownerId), /cleanup_audit_missing/)
  }
})
