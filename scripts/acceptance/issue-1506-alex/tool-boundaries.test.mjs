import assert from 'node:assert/strict'
import test from 'node:test'
import { DURING_TOOL_DELAY_MS, runToolStop } from './coordinator-tool-stop.mjs'
import { fakeSession, fixtureReceipt, PRIVATE, SHA } from './fixture-support.mjs'
import { classifyToolBoundary } from './tool-boundary-evidence.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }

function withImmediateStream(fixture, terminal) {
  return (work, options) => fixture.provider(session => work({ ...session,
    async request(path, input) {
      const response = await session.request(path, input)
      if (!path.startsWith('/api/coordinator/stream?')) return response
      await response.body.cancel()
      const id = 'wrun_fixture1:0'
      const frames = [{ type: 'start', id, sequence: 1 },
        { type: 'tool', id, sequence: 2, name: 'web_search', call: PRIVATE, state: 'running', input: PRIVATE },
        terminal === 'error' ? { type: 'error', sequence: 3, message: PRIVATE }
          : { type: 'tool', id, sequence: 3, name: 'web_search', call: PRIVATE, state: 'done', output: PRIVATE }]
      return new Response(frames.map(row => JSON.stringify(row)).join('\n') + '\n', { headers: response.headers })
    },
  }), options)
}

test('before-tool sample stops once at the real public frame and still claims no runtime boundary', async () => {
  const f = fakeSession({ readyBots: true, stream: 'tool' })
  const report = await runToolStop({ ...f.options, env: { ...f.options.env, MIKKA_STOP_CASE: 'before_tool' } })
  assert.equal(report.status, 'observed'); assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1)
  assert.equal(report.sample.plannedDelayMs, 0); assert.equal(report.sample.attempts, 1)
  assert.equal(report.stop.trigger, 'public_web_search_running'); assert.equal(report.streamId, 'wrun_fixture1:0')
  assert.equal(report.runtimeBoundary.classification, 'unverified'); assert.equal(report.publicRunningCallCount, 1)
  assert.ok(report.stop.acknowledgedAt >= report.stop.requestedAt)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('during-tool sample uses exactly one fixed 600ms delay, then one normal stop without asserting execute entered', async () => {
  const f = fakeSession({ readyBots: true, stream: 'tool' })
  const report = await runToolStop({ ...f.options, streamTimeoutMs: 2000,
    env: { ...f.options.env, MIKKA_STOP_CASE: 'during_tool' } })
  assert.equal(DURING_TOOL_DELAY_MS, 600); assert.equal(report.sample.plannedDelayMs, 600)
  assert.equal(report.status, 'observed', JSON.stringify(report)); assert.equal(f.state.sends, 1); assert.equal(f.state.stops, 1)
  assert.equal(report.stop.trigger, 'public_web_search_running_after_fixed_delay')
  assert.ok(report.metrics.delayAfterToolCallMs >= 590)
  assert.equal(report.runtimeBoundary.executeEntered, 'not_observed'); assert.equal(report.runtimeBoundary.classification, 'unverified')
  assert.equal(report.sample.countedEvenIfBoundaryMissed, true); assert.equal(report.postStopChatReads, 1)
})

test('an early tool finish and EOF do not convert a delayed sample into a false in-tool observation or issue two stops', async () => {
  const f = fakeSession({ readyBots: true, stream: 'tool' })
  const report = await runToolStop({ ...f.options, streamTimeoutMs: 2000, sessionProvider: withImmediateStream(f, 'done'),
    env: { ...f.options.env, MIKKA_STOP_CASE: 'during_tool' } })
  assert.equal(report.termination, 'eof'); assert.equal(f.state.stops, 1); assert.equal(f.state.sends, 1)
  assert.equal(report.tools.at(-1).state, 'done'); assert.equal(report.tools.at(-1).afterStopRequest, false)
  assert.ok(report.metrics.streamClosedMs < report.metrics.stopRequestedMs)
  assert.equal(report.runtimeBoundary.classification, 'unverified'); assert.equal(report.sample.attempts, 1)
})

test('a stream error cancels the sample timer, stops once immediately for cleanup and retains failure', async () => {
  const f = fakeSession({ readyBots: true, stream: 'tool' })
  const report = await runToolStop({ ...f.options, streamTimeoutMs: 2000, sessionProvider: withImmediateStream(f, 'error'),
    env: { ...f.options.env, MIKKA_STOP_CASE: 'during_tool' } })
  assert.equal(report.status, 'failed'); assert.equal(report.error, 'stream_error')
  assert.equal(report.sample.delayCancelledByFailure, true); assert.equal(report.stop.trigger, 'error_cleanup')
  assert.equal(report.metrics.delayAfterToolCallMs, undefined); assert.equal(f.state.stops, 1); assert.equal(f.state.sends, 1)
  assert.equal(report.postStopChatReads, 1); assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

function evidenceFixture(requestedCase = 'during_tool') {
  const receipt = fixtureReceipt(), row = receipt.fixtures[0], run = 'wrun_boundary_production_shape', callRef = 'a'.repeat(12)
  const observation = { applicationSha: SHA, workflowRunId: run, streamId: run + ':0', triggerCallRef: callRef,
    requestedCase, fixture: { key: row.key, botId: row.botId, runKey: receipt.runKey }, status: 'observed', termination: 'eof',
    stop: { acknowledged: true, requestedAt: 9_000_000 },
    sample: { attempts: 1, countedEvenIfBoundaryMissed: true, plannedDelayMs: requestedCase === 'during_tool' ? 600 : 0 } }
  const evidence = { schemaVersion: 1,
    scope: { applicationSha: SHA, ownerRef: receipt.ownerRef, workspaceId: receipt.workspace.id, botId: row.botId,
      workflowRunId: run, streamId: run + ':0' },
    execution: { id: '88888888-8888-4888-8888-888888888888', executionKey: run + ':0', status: 'completed',
      webSearchAllowed: true, finishedAt: 2200 }, auditReadAt: 5000,
    audit: [{ kind: 'tool_started', tool: 'web_search', callRef, at: 900 },
      { kind: 'tool_finished', tool: 'web_search', callRef, at: 3100, outcome: 'ok' }],
    toolTimings: [{ msg: 'coordinator_tool_timing', tool: 'web_search', workflowRunId: run, stepId: 'step_real_body',
      attempt: 1, callRef, startedAt: 1000, endedAt: 3000, outcome: 'ok' }],
    stopTimings: [{ msg: 'coordinator_stop_timing', workflowRunId: run, requestedAt: 2000, acknowledgedAt: 2050, outcome: 'accepted' }] }
  return { receipt, observation, evidence }
}

test('only the immutable stopped audit outcome proves the post-audit body was skipped', () => {
  const f = evidenceFixture('before_tool')
  f.evidence.toolTimings = []; f.evidence.audit[1].outcome = 'stopped'
  const result = classifyToolBoundary(f.observation, f.evidence, f.receipt)
  assert.equal(result.status, 'covered'); assert.equal(result.classification, 'before_tool')
  assert.equal(result.proof, 'immutable_post_audit_stopped_outcome_skipped_body')
  assert.equal(result.overallAcceptance, 'requires_final_side_effect_and_provider_review')
  f.evidence.audit[1].outcome = 'ok'
  assert.equal(classifyToolBoundary(f.observation, f.evidence, f.receipt).status, 'not_covered')
})

test('during classification uses the entire real server stop interval, independent of runner wall-clock time', () => {
  const f = evidenceFixture()
  const result = classifyToolBoundary(f.observation, f.evidence, f.receipt)
  assert.equal(result.status, 'covered'); assert.equal(result.classification, 'during_tool')
  assert.equal(result.sampleCount, 1); assert.equal(result.body.startedAt, 1000); assert.equal(result.stop.requestedAt, 2000)
  assert.ok(result.audit.finishedAt > f.evidence.execution.finishedAt, 'a legitimate already-started tool may finish its audit after stopped execution completion')
  assert.equal(result.overallAcceptance, 'requires_final_side_effect_and_provider_review')
})

test('after-tool, partially overlapping and equality boundaries are retained as not covered', () => {
  for (const [startedAt, endedAt] of [[100, 1900], [2000, 3000], [1000, 2050], [2020, 3000], [2100, 3000]]) {
    const f = evidenceFixture(); Object.assign(f.evidence.toolTimings[0], { startedAt, endedAt })
    const result = classifyToolBoundary(f.observation, f.evidence, f.receipt)
    assert.equal(result.status, 'not_covered', JSON.stringify(result)); assert.equal(result.sampleCount, 1)
  }
})

test('missing final audit, duplicate attempts or another tool call cannot satisfy the requested boundary', () => {
  const fixtures = [evidenceFixture(), evidenceFixture(), evidenceFixture(), evidenceFixture()]
  fixtures[0].evidence.audit.pop()
  fixtures[1].evidence.toolTimings.push({ ...fixtures[1].evidence.toolTimings[0], attempt: 2 })
  fixtures[2].evidence.audit.push({ ...fixtures[2].evidence.audit[0], callRef: 'b'.repeat(12) })
  fixtures[3].evidence.execution.status = 'running'
  for (const f of fixtures) assert.equal(classifyToolBoundary(f.observation, f.evidence, f.receipt).status, 'not_covered')
})

test('foreign scope and contradictory entered/stopped evidence are rejected; extra source content never appears in output', () => {
  const f = evidenceFixture(); f.evidence.scope.botId = 'foreign'
  assert.throws(() => classifyToolBoundary(f.observation, f.evidence, f.receipt), /boundary_scope_mismatch/)
  const malformed = evidenceFixture(); malformed.observation.status = PRIVATE
  assert.throws(() => classifyToolBoundary(malformed.observation, malformed.evidence, malformed.receipt), /boundary_scope_mismatch/)
  const conflicting = evidenceFixture('before_tool'); conflicting.evidence.audit[1].outcome = 'stopped'
  assert.throws(() => classifyToolBoundary(conflicting.observation, conflicting.evidence, conflicting.receipt), /boundary_evidence_conflict/)
  const privateExtra = evidenceFixture(); privateExtra.evidence.rawInput = PRIVATE
  privateExtra.evidence.toolTimings[0].output = PRIVATE
  assert.equal(JSON.stringify(classifyToolBoundary(privateExtra.observation, privateExtra.evidence, privateExtra.receipt)).includes(PRIVATE), false)
})

test('a sample landing on the other side or failing its client stop remains in the denominator without passing', () => {
  const f = evidenceFixture('before_tool'), result = classifyToolBoundary(f.observation, f.evidence, f.receipt)
  assert.equal(result.classification, 'during_tool'); assert.equal(result.status, 'not_covered'); assert.equal(result.reason, 'observed_other_boundary')
  f.observation.requestedCase = 'during_tool'; f.observation.sample.plannedDelayMs = 600; f.observation.status = 'failed'
  assert.equal(classifyToolBoundary(f.observation, f.evidence, f.receipt).reason, 'client_stop_observation_failed')
})
