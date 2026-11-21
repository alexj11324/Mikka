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

test('null-context dispatch requires a successful entry containing an owned server interval', () => {
  const owned = { msg: 'cloud_startup_timing', stage: 'cloud.thread.ensure', runIdHash: hash,
    startedAt: epoch + 100, endedAt: epoch + 1900, ms: 1800 }
  const nativeDispatch = { ...dispatch, workflowRunId: null, stepId: null, attempt: null, boundary: 'dispatch_run_entry' }
  const scoped = { ...scope, ownedIntervals: [owned] }
  assert.deepEqual(sanitizeTimingLog({ ...nativeDispatch, PRIVATE: 'PRIVATE' }, scoped), nativeDispatch)
  assert.equal(sanitizeTimingLog(nativeDispatch, scope), null)
  for (const interval of [{ ...owned, runIdHash: 'f'.repeat(16) }, { ...owned, stage: 'cloud.worker.claim' },
    { ...owned, startedAt: epoch - 1 }, { ...owned, endedAt: epoch + 2001 }, { ...owned, endedAt: epoch }]) {
    assert.equal(sanitizeTimingLog(nativeDispatch, { ...scope, ownedIntervals: [interval] }), null)
  }
  for (const value of [{ ...nativeDispatch, workflowRunId: 'wrun_FOREIGN' }, { ...nativeDispatch, failed: true },
    { ...nativeDispatch, boundary: undefined }, { ...nativeDispatch, phases: [{ phase: 'PRIVATE', ms: 1 }] }]) {
    assert.equal(sanitizeTimingLog(value, scoped), null)
  }
})

test('collects null-context dispatch across pages without retaining unrelated or private records', async () => {
  const nativeDispatch = { ...dispatch, workflowRunId: null, stepId: null, attempt: null, boundary: 'dispatch_run_entry' }
  const owned = { msg: 'cloud_startup_timing', stage: 'cloud.thread.ensure', runIdHash: hash,
    startedAt: epoch + 100, endedAt: epoch + 1900, ms: 1800 }
  const input = report(); input.samples[0].eveSessionId = workflow
  let pages = 0
  const read = async (path, body) => {
    if (path.startsWith('/v13/')) return { gitSource: { sha: input.build }, readyState: 'READY', target: 'production' }
    assert.equal(path, '/v1/observability/events')
    assert.match(body.filter, /AND \(dispatch_timing OR \(/)
    assert.match(body.filter, new RegExp(hash)); assert.match(body.filter, new RegExp(workflow))
    assert.deepEqual(body.timeRange, { start: new Date(epoch - 5000).toISOString(), end: new Date(epoch + 10000).toISOString() })
    const records = pages++ === 0 ? [nativeDispatch, { ...nativeDispatch, workflowRunId: 'wrun_FOREIGN' },
      { ...nativeDispatch, startedAt: epoch + 5000, endedAt: epoch + 7000 }, { ...nativeDispatch, failed: true },
      { ...owned, runIdHash: 'f'.repeat(16) }] : [owned, native]
    return { events: records.map(log => ({ deploymentId, environment: 'production', message: JSON.stringify({ ...log, PRIVATE: 'PRIVATE' }) })),
      pagination: pages === 1 ? { hasMore: true, nextCursor: 'next' } : { hasMore: false } }
  }
  const result = await collectProductionTimings(input, { token: 'PRIVATE', deploymentId, now: () => epoch + 10000, read })
  assert.equal(pages, 2)
  assert.equal(result.status, 'baseline_recorded')
  assert.equal(result.samples[0].timing.dispatchBoundary, 'dispatch_run_entry')
  assert.deepEqual(result.serverTimingLogs.filter(log => log.msg === 'dispatch_timing'), [nativeDispatch])
  assert.equal(result.serverLogCollection.status, 'partial')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|FOREIGN|ffffffffffffffff/)
})

test('unscoped and ambiguous null-context dispatch cannot become timing proof', async () => {
  const nativeDispatch = { ...dispatch, workflowRunId: null, stepId: null, attempt: null, boundary: 'dispatch_run_entry' }
  const owned = { msg: 'cloud_startup_timing', stage: 'cloud.thread.ensure', runIdHash: hash,
    startedAt: epoch + 100, endedAt: epoch + 1900, ms: 1800 }
  for (const [nativeSession, records, reason] of [[false, [nativeDispatch, owned], 'dispatch_log_missing'],
    [true, [nativeDispatch], 'dispatch_log_missing'],
    [true, [nativeDispatch, { ...nativeDispatch, startedAt: epoch - 10 }, owned], 'ambiguous_dispatch']]) {
    const input = report()
    if (nativeSession) input.samples[0].eveSessionId = workflow
    const result = await collectProductionTimings(input, { token: 'PRIVATE', deploymentId, now: () => epoch + 10000,
      read: async path => path.startsWith('/v13/') ? { gitSource: { sha: input.build }, readyState: 'READY', target: 'production' }
        : { events: records.map(log => ({ deploymentId, environment: 'production', message: JSON.stringify(log) })), pagination: { hasMore: false } } })
    assert.equal(result.status, 'failed')
    assert.equal(result.samples[0].timing.reason, reason)
  }
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

test('reports prepared and late initialization on separate interval origins without adding their overlap', () => {
  const value = report(), sample = value.samples[0]
  sample.daemonStartupTiming = { ms: 100, phases: [{ name: 'daemon.adapter.cli_init', startMs: 10, endMs: 30, ms: 20, outcome: 'ok' }] }
  sample.daemonPreparationTiming = { ms: 2400, source: 'prepared_agent_start', phases: [
    { name: 'daemon.adapter.cli_init.prewarm', startMs: 50, endMs: 1050, ms: 1000, outcome: 'ok' },
    { name: 'daemon.adapter.cli_init', startMs: 2300, endMs: 2320, ms: 20, outcome: 'ok' },
    { name: 'daemon.adapter.cli_init', startMs: 2310, endMs: 2330, ms: 20, outcome: 'ok' }] }
  const rendered = markdown(summarizeTimings(value, [dispatch]))
  assert.match(rendered, /\| `daemon\.adapter\.start` \| 0\.100 \| 0\.100 \| 0\.100 \|/)
  assert.match(rendered, /\| `daemon\.adapter\.preparation` \| 2\.400 \| 2\.400 \| 2\.400 \|/)
  assert.match(rendered, /\| `daemon\.adapter\.cli_init` \| 0\.020 \| 0\.020 \| 0\.020 \|/)
  assert.match(rendered, /\| `daemon\.preparation\.cli_init` \| 0\.030 \| 0\.030 \| 0\.030 \|/)
  assert.match(rendered, /\| `daemon\.preparation\.cli_init\.prewarm` \| 1\.000 \| 1\.000 \| 1\.000 \|/)
  assert.match(rendered, /独立的预热起点.*等待 checkout.*不能相加/)
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
  assert.match(rendered, /\| test \/ 1\.1 \| unavailable \| — \| unavailable \|/)
  sample.runtimeTiming.mcpHttpTiming.version = 2
  sample.runtimeTiming.mcpHttpTiming.requests[0].body = { endedAt: epoch + 2750, durationMs: 550, outcome: 'read' }
  sample.runtimeTiming.mcpHttpTiming.requests[1].body = null
  const bodyRendered = markdown(value)
  assert.match(bodyRendered, /\| test \/ 1\.1 \| decision_catalogue .*\| 0\.050 \| -1\.300 \| ok \|/)
  assert.match(bodyRendered, /\| test \/ 1\.1 \| [^|]+ \| 0\.550 \| read \|/)
  assert.match(bodyRendered, /\| test \/ 1\.2 \| unavailable \| — \| unavailable \|/)
})
