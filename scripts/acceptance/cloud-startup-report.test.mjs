import assert from 'node:assert/strict'
import test from 'node:test'
import { collectProductionTimings, markdown, sanitizeTimingLog, summarizeTimings } from './cloud-startup-report.mjs'

const epoch = Date.parse('2026-11-06T12:00:00.000Z'), hash = 'a'.repeat(16), workflow = 'wrun_TEST1', deploymentId = 'dpl_Test'
const scope = { hashes: new Set([hash]), workflows: new Set([workflow]) }
const dispatch = { msg: 'dispatch_timing', workflowRunId: workflow, stepId: 'step_1', attempt: 1,
  startedAt: epoch, endedAt: epoch + 2000, totalMs: 2000, failed: false, phases: [{ phase: 'ensureThreadMachine', ms: 1500 }], github: { requests: 1, ms: 25 } }
const native = { msg: 'subscription_native_timing', runIdHash: hash, operation: 'request', startedAt: epoch + 2500, endedAt: epoch + 2620,
  ms: 120, outcome: 'ok', truncated: false, phases: [{ phase: 'binding', startMs: 0, ms: 8, outcome: 'ok' },
    { phase: 'access', startMs: 8, ms: 12, outcome: 'ok' }, { phase: 'provider_headers', startMs: 20, ms: 100, outcome: 'ok' }],
  traceId: 'b'.repeat(32), spanId: 'c'.repeat(16) }
const report = () => ({ startedAt: new Date(epoch).toISOString(), build: 'd'.repeat(40), mode: 'baseline', requestedStrategy: 'official', maxStartupMs: 5000,
  cleanup: { errors: [] }, samples: [{ sampleId: 'test', harness: 'claude_code', runIdHash: hash, workflowRunId: workflow,
    status: 'execution_proved_awaiting_server_timing', cleanup: { status: 'passed' }, execution: { credentialType: 'subscription' },
    agentStart: { storedAt: new Date(epoch + 3500).toISOString() }, firstProviderChunk: { storedAt: new Date(epoch + 8000).toISOString() } }] })

test('keeps fixed numeric phases, rejects foreign identities, and drops private log attributes', () => {
  const sanitized = sanitizeTimingLog({ ...native, credential: 'PRIVATE', payload: 'PRIVATE', phases: native.phases.map(phase => ({ ...phase, prompt: 'PRIVATE' })) }, scope)
  assert.deepEqual(sanitized, native)
  assert.doesNotMatch(JSON.stringify(sanitized), /PRIVATE|credential|payload|prompt/)
  assert.equal(sanitizeTimingLog({ ...native, runIdHash: '0'.repeat(16) }, scope), null)
  assert.equal(sanitizeTimingLog({ ...native, phases: [{ phase: 'PRIVATE', ms: 1, startMs: 0, outcome: 'ok' }] }, scope), null)
  assert.equal(sanitizeTimingLog({ ...dispatch, boundary: 'dispatch_run_entry' }, scope).boundary, 'dispatch_run_entry')
  assert.equal(sanitizeTimingLog(dispatch, scope).boundary, undefined)
  assert.equal(sanitizeTimingLog({ ...dispatch, boundary: 'PRIVATE' }, scope), null)
})

test('aligns exact dispatch evidence and reports raw median/max with honest proxy lower-bound semantics', () => {
  const aligned = summarizeTimings(report(), [dispatch, native])
  assert.equal(aligned.status, 'baseline_recorded')
  assert.equal(aligned.samples[0].nativeProviderCalls[0].measuredPreparationLowerBoundMs, 20)
  assert.equal(aligned.samples[0].nativeProviderCalls[0].providerHeadersIncludingUpstreamMs, 100)
  assert.deepEqual(aligned.summary.groups[0].dispatchToAgentStart, { valuesMs: [3500], medianMs: 3500, maxMs: 3500 })
  assert.equal(aligned.samples[0].timing.dispatchToFirstProviderChunkMs, 8000)
  assert.doesNotMatch(JSON.stringify(aligned.summary), /p95/i)
})

test('uses bounded read-only provider queries and never retains raw envelopes or missing logs as zero calls', async () => {
  const calls = []
  const read = async (path, body) => {
    calls.push({ path, body })
    if (path.startsWith('/v13/')) return { gitSource: { sha: 'd'.repeat(40) }, readyState: 'READY', target: 'production' }
    assert.equal(path, '/v1/observability/events')
    assert.match(body.filter, new RegExp(hash)); assert.match(body.filter, new RegExp(workflow))
    return { events: [dispatch, native].map(log => ({ deploymentId, environment: 'production', message: JSON.stringify({ ...log, PRIVATE: 'PRIVATE' }),
      rawHeaders: { authorization: 'PRIVATE' } })), pagination: { hasMore: false } }
  }
  const result = await collectProductionTimings(report(), { token: 'PRIVATE', deploymentId, now: () => epoch + 10000, read })
  assert.equal(result.status, 'baseline_recorded'); assert.equal(result.serverLogCollection.status, 'query_complete')
  assert.equal(calls.length, 2); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|rawHeaders|authorization/)
  const missing = await collectProductionTimings(report(), { token: 'PRIVATE', deploymentId, now: () => epoch + 10000,
    read: async path => path.startsWith('/v13/') ? { gitSource: { sha: 'd'.repeat(40) }, readyState: 'READY', target: 'production' }
      : { events: [], pagination: { hasMore: false } } })
  assert.equal(missing.status, 'failed'); assert.match(missing.serverLogCollection.coverage, /not_proof_of_zero/)
})

test('keeps drifted raw evidence but excludes it from fixed-version statistics', () => {
  const input = report()
  input.samples.push({ ...input.samples[0], sampleId: 'drifted', status: 'failed', error: 'startup_build_mismatch' })
  input.error = 'startup_build_mismatch'
  const result = summarizeTimings(input, [dispatch, native])
  assert.equal(result.status, 'failed')
  assert.equal(result.samples[1].timing.dispatchToAgentStartMs, 3500)
  assert.deepEqual(result.summary.excludedSamples, [{ sampleId: 'drifted', reason: 'startup_build_mismatch' }])
  assert.equal(result.summary.groups[0].samples, 1)
  assert.deepEqual(result.summary.groups[0].dispatchToAgentStart.valuesMs, [3500])
})

test('retains closed worker-claim phases and marks unavailable runtime proof honestly', () => {
  const claim = { msg: 'cloud_startup_timing', runIdHash: hash, stage: 'cloud.worker.claim.phases', phases: [
    { phase: 'assignment_context', startedAt: epoch, endedAt: epoch + 200, ms: 200 },
    { phase: 'credentials_wait', startedAt: epoch + 200, endedAt: epoch + 220, ms: 20 }] }
  const native = { msg: 'cloud_startup_timing', runIdHash: hash, stage: 'cloud.worker.claim.native_credentials',
    startedAt: epoch + 50, endedAt: epoch + 220, ms: 170 }
  assert.deepEqual(sanitizeTimingLog(claim, scope), claim)
  assert.deepEqual(sanitizeTimingLog(native, scope), native)
  assert.equal(sanitizeTimingLog({ ...claim, phases: [{ ...claim.phases[0], phase: 'PRIVATE' }] }, scope), null)
  const rendered = markdown(summarizeTimings(report(), [dispatch, claim, native]))
  assert.match(rendered, /legacy_dispatch_body/)
  assert.match(rendered, /claim\.native_credentials/)
  assert.match(rendered, /\| test \| unavailable \| unavailable \| unavailable \| unavailable \|/)
  assert.match(rendered, /best_effort/)
})

test('business request output preserves actual ACK ordering and unknown child generations without claiming all HTTP coverage', () => {
  const value = report(), sample = value.samples[0]
  sample.runtimeTiming = { complete: true, truncated: false, agentAccepted: { kind: 'claude_user_ack', at: epoch + 3500 },
    mcpHttpTiming: { requests: [{ child: 1, sequence: 1, operation: 'decision_catalogue', startedAt: epoch + 2200,
      endedAt: epoch + 2250, durationMs: 50, outcome: 'ok' }, { child: 1, sequence: 2, operation: 'decision_record',
      startedAt: epoch + 4000, endedAt: null, durationMs: null, outcome: 'pending' }] } }
  sample.runtimeEvidence = { status: 'passed', extraRemoteCalls: 0, allFirstPartyHttpComplete: false, childBusiness: {
    status: 'observed', observedChildren: 1, closedChildren: 0, observedCatalogueSends: 1, observedDecisionSends: 1,
    pendingObservedSends: 1, observedComplete: false, childLifecycleComplete: false, remoteMcpServerCount: 0 } }
  const rendered = markdown(value)
  assert.match(rendered, /generationCoverage=unverified、allFirstPartyHttpComplete=false/)
  assert.match(rendered, /宿主收据完整/)
  assert.match(rendered, /\| test \/ 1\.1 \| decision_catalogue .*\| 0\.050 \| -1\.300 \| ok \|/)
  assert.match(rendered, /\| test \/ 1\.2 \| decision_record .*\| unavailable \| — \| 0\.500 \| pending \|/)
  assert.match(rendered, /未观测世代的请求总数是 unavailable/)
  assert.doesNotMatch(rendered, /allFirstPartyHttpComplete=true|all_mikka_http_sends_during_execution_counted/)
})
