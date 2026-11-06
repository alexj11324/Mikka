import assert from 'node:assert/strict'
import test from 'node:test'
import { setupWorkspace, validateWorkspaceReceipt } from './workspace-setup.mjs'
import { runFixtureSetup, validateFixtureReceipt } from './coordinator-fixtures.mjs'
import { runBaseline } from './coordinator-baseline.mjs'
import { runCacheTurns } from './coordinator-cache-turns.mjs'
import { runToolStop } from './coordinator-tool-stop.mjs'
import { fakeSession, fixtureReceipt, workspaceReceipt, PRIVATE, SHA, BOT_IDS } from './fixture-support.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }

test('workspace setup creates only a new owned single-member team and shares existing resources without model calls', async () => {
  const f = fakeSession({ readyWorkspace: false })
  const report = await setupWorkspace({ env: f.options.env, sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'ready', JSON.stringify(report)); assert.equal(f.state.creates, 1)
  assert.equal(f.state.subWrites, 1); assert.equal(f.state.creditWrites, 1); assert.equal(f.state.sends, 0)
  assert.equal(report.balanceWrites, 0); assert.equal(report.shares.allowOthers, false); assert.equal(report.signedOut, true)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
  assert.equal(validateWorkspaceReceipt(report), report)
})

test('a lost workspace create acknowledgement is discovered once, never created twice', async () => {
  const f = fakeSession({ readyWorkspace: false, lostWorkspaceAck: true })
  const report = await setupWorkspace({ env: f.options.env, sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'ready'); assert.equal(f.state.creates, 1)
  assert.equal(report.creationOutcome, 'recovered_after_unknown_no_retry')
})

test('workspace extra members or an incorrect account cannot acquire test shares', async () => {
  for (const flags of [{ extraMember: true }, { wrongOwner: true }]) {
    const f = fakeSession(flags)
    const report = await setupWorkspace({ env: f.options.env, sessionProvider: f.provider, checkpoint: false })
    assert.equal(report.status, 'failed'); assert.equal(f.state.subWrites, 0); assert.equal(f.state.creditWrites, 0)
    assert.equal(f.state.sends, 0); assert.equal(f.state.signouts, 1)
  }
})

test('exactly two new bots receive independent owned Haiku and Luna menu choices', async () => {
  const f = fakeSession()
  const report = await runFixtureSetup({ env: f.options.env, workspaceReceipt: workspaceReceipt(), sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'ready', JSON.stringify(report)); assert.equal(f.state.botCreates, 2); assert.equal(f.state.choices, 2)
  assert.deepEqual(report.fixtures.map(row => row.model), ['claude-haiku-5-5', 'gpt-6-luna'])
  assert.equal(new Set(report.fixtures.map(row => row.botId)).size, 2); assert.equal(f.state.sends, 0)
  assert.equal(f.state.subWrites, 0); assert.equal(f.state.creditWrites, 0)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
  validateFixtureReceipt(report, { ready: true })
})

test('lost bot and selection acknowledgements use discovery, with no repeated writes', async () => {
  const f = fakeSession({ lostBotAck: true, lostSelectionAck: true })
  const report = await runFixtureSetup({ env: f.options.env, workspaceReceipt: workspaceReceipt(), sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'ready', JSON.stringify(report)); assert.equal(f.state.botCreates, 2); assert.equal(f.state.choices, 2)
  assert.equal(report.fixtures.every(row => row.creationOutcome === 'recovered_after_unknown'), true)
})

test('all message drivers reject owner, membership, bot ownership, fallback and a busy chat without sending', async () => {
  for (const driver of [runBaseline, runCacheTurns, runToolStop]) for (const flags of [
    { wrongOwner: true }, { extraMember: true }, { wrongBotOwner: true }, { fallback: true }, { busy: true },
  ]) {
    const f = fakeSession({ readyBots: true, ...flags })
    const report = await driver(f.options)
    assert.equal(report.status, 'failed'); assert.equal(f.state.sends, 0); assert.equal(f.state.stops, 0)
    assert.equal(f.state.signouts, 1)
  }
})

for (const key of ['haiku', 'luna']) test(key + ' model-stream baseline keeps the selected fixture and stops once at first text', async () => {
  const f = fakeSession({ readyBots: true })
  const report = await runBaseline({ ...f.options, env: { ...f.options.env, MIKKA_FIXTURE_KIND: key } })
  assert.equal(report.status, 'observed', JSON.stringify(report)); assert.equal(report.fixture.key, key)
  assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1); assert.equal(report.postStopChatReads, 1)
  assert.equal(report.menu.chosen, true); assert.equal(report.menu.listedAsOwnOption, true)
  assert.equal(report.runtimeEvidence.confirmed, false); assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('complete cache turns wait for committed and EOF plus one idle read before the next send', async () => {
  const f = fakeSession({ readyBots: true, stream: 'complete' })
  const report = await runCacheTurns(f.options)
  assert.equal(report.status, 'observed', JSON.stringify(report)); assert.equal(f.state.sends, 2); assert.equal(f.state.stops, 0)
  assert.equal(report.turns.every(row => row.termination === 'eof' && row.committedObserved && row.postTurnChatReads === 1), true)
  assert.equal(report.runtimeEvidence.cacheReadTokens, 'not_observed'); assert.equal(f.state.syncs, 3)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('cache timeout or lost send acknowledgement cannot repeat a message and uses one scoped stop', async () => {
  for (const flags of [{ stream: 'complete', noEof: true }, { sendLost: true }]) {
    const f = fakeSession({ readyBots: true, ...flags })
    const report = await runCacheTurns(f.options)
    assert.equal(report.status, 'failed'); assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1)
    assert.equal(report.turns[0].postTurnChatReads, 1); assert.equal(f.state.signouts, 1)
  }
})

test('real-shaped tool-running frame triggers one stop but cannot claim execute-enter or before/during classification', async () => {
  const f = fakeSession({ readyBots: true, stream: 'tool' })
  const report = await runToolStop(f.options)
  assert.equal(report.status, 'observed', JSON.stringify(report)); assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1)
  assert.equal(report.runtimeBoundary.classification, 'unverified'); assert.equal(report.runtimeBoundary.executeEntered, 'not_observed')
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('independent cleanup only hides the two exact receipt bots and needs no current deployment match', async () => {
  const f = fakeSession({ readyBots: true })
  const report = await runFixtureSetup({ mode: 'cleanup', receipt: fixtureReceipt(), env: { MIKKA_ACCEPTANCE_SHA: 'b'.repeat(40) }, sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'cleanup_complete', JSON.stringify(report)); assert.deepEqual(f.state.hidden, BOT_IDS)
  assert.equal(f.state.sends, 0); assert.equal(f.state.choices, 0); assert.equal(f.state.stops, 0)
  const malicious = fixtureReceipt(); malicious.workspace.id = '4ae2a643-b09e-43eb-816c-1e5557bef170'
  assert.throws(() => validateFixtureReceipt(malicious), /fixture_receipt_invalid/)
  assert.equal(SHA.length, 40)
})
