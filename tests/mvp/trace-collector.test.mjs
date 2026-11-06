import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { AlwaysOnSampler, BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { LoggerProvider, SimpleLogRecordProcessor, InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import { decodeOtlp, summarizeAiSpans, summarizeTraceChain } from './trace-collector.mjs'

// Test the small collector reader against the installed official exporter
// serializers, including binary IDs, typed attributes and log span context.
const require = createRequire(import.meta.url)
const { ProtobufTraceSerializer, ProtobufLogsSerializer } = require(require.resolve('@opentelemetry/otlp-transformer', {
  paths: [dirname(require.resolve('@opentelemetry/exporter-trace-otlp-proto'))],
}))
test('unfinished trace evidence identifies split runs and missing parents without retaining private fields', () => {
  const traceId = '1'.repeat(32), otherTrace = '2'.repeat(32), runId = '11111111-2222-4333-8444-555555555555'
  let seq = 0
  const span = (name, extra = {}) => ({ name, service: 'mikka-daemon', traceId, spanId: (++seq).toString(16).padStart(16, '0'),
    status: 0, attributes: { prompt: 'private-input', 'mikka.run_id': runId }, ...extra })
  const run = span('daemon.run'), parent = span('POST /v1/runs/[runId]/complete')
  const evidence = { spans: [
    { ...run, traceId: otherTrace }, span('daemon.registration', { traceId: otherTrace }),
    ...['daemon.run.repository', 'daemon.run.worktree', 'daemon.adapter.start', 'workflow.execute', 'step.execute', 'pg.query'].map(name => span(name)),
    span('POST /v1/runs/[runId]/complete', { service: 'mikka-web', parentSpanId: parent.spanId }),
  ], logs: [{ traceId, spanId: run.spanId, body: 'private-log', attributes: { token: 'private-token' } }] }
  const pending = summarizeTraceChain(evidence, runId, traceId)
  assert.equal(pending.ready, false)
  assert.equal(pending.daemonRuns.inTrace, 0)
  assert.equal(pending.daemonRuns.otherTraces, 1)
  assert.equal(pending.checks.registration, false)
  assert.equal(pending.checks.completionParent, false)
  assert.equal(pending.checks.runLog, false)
  assert.equal(pending.completions.inTrace, 1)
  assert.equal(pending.completions.ids[0].parentPresent, false)
  evidence.spans.push(run, parent, span('daemon.registration'))
  const arrived = summarizeTraceChain(evidence, runId, traceId)
  assert.equal(arrived.ready, true)
  assert.equal(arrived.runLogs, 1)
  assert.equal(arrived.completions.withParent, 1)
  assert.equal(arrived.steps.inTrace, 1)
  for (let index = 0; index < 12; index++) evidence.spans.push(span('private-name/complete', { service: 'mikka-web', parentSpanId: 'private-parent' }))
  const bounded = summarizeTraceChain(evidence, runId, traceId)
  assert.equal(bounded.completions.ids.length, 8)
  assert.equal(bounded.completions.ids.at(-1).parentSpanId, null)
  assert.ok(!JSON.stringify([pending, arrived, bounded]).includes('private'))
  const refused = summarizeTraceChain(evidence, 'private-run', 'private-trace')
  assert.equal(refused.runId, null); assert.equal(refused.traceId, null); assert.equal(refused.ready, false)
  assert.ok(!JSON.stringify(refused).includes('private'))
})

test('AI failure summary distinguishes both service span names and exports only closed categories', () => {
  const spans = [
    { name: 'mikka.ai.generation', service: 'mikka-web', status: 2, traceId: 'private-trace', attributes: { 'mikka.ai.operation': 'coordinator', 'error.type': 'AI_APICallError', prompt: 'private prompt' } },
    { name: 'mikka.ai.generation', service: 'mikka-web', status: 2, attributes: { 'mikka.ai.operation': 'coordinator', 'error.type': 'AI_APICallError' } },
    { name: 'daemon.ai.generation', service: 'mikka-daemon', status: 0, attributes: { 'mikka.ai.operation': 'agent' } },
    { name: 'mikka.ai.generation', service: 'private-service', status: 2, attributes: { 'mikka.ai.operation': 'private-operation', 'error.type': 'private-code' } },
    { name: 'daemon.run', service: 'mikka-daemon', attributes: {} },
  ]
  const summary = summarizeAiSpans(spans)
  assert.equal(summary.total, 4)
  assert.equal(summary.errors, 3)
  assert.deepEqual(summary.byService, { web: 2, daemon: 1, other: 1 })
  assert.deepEqual(summary.bySpanName, { 'mikka.ai.generation': 3, 'daemon.ai.generation': 1 })
  assert.deepEqual(summary.groups[0], { span: 'mikka.ai.generation', service: 'web', operation: 'coordinator', errorType: 'AI_APICallError', count: 2 })
  assert.ok(!JSON.stringify(summary).includes('private'))
  assert.equal(summarizeAiSpans([]).total, 0)
})

test('decodes the exact production OTLP wire format and retains only explicit metadata', async () => {
  const resource = resourceFromAttributes({ 'service.name': 'mikka-daemon' })
  const traces = new InMemorySpanExporter(), logs = new InMemoryLogRecordExporter()
  const tracer = new BasicTracerProvider({ resource, sampler: new AlwaysOnSampler(), spanProcessors: [new SimpleSpanProcessor(traces)] })
  const logger = new LoggerProvider({ resource, processors: [new SimpleLogRecordProcessor({ exporter: logs })] })
  const span = tracer.getTracer('fixture').startSpan('daemon.run', { attributes: { 'mikka.run_id': 'run_fixture', 'mikka.ai.input_tokens': 12, prompt: 'private prompt' } })
  span.setStatus({ code: SpanStatusCode.ERROR }); span.end()
  logger.getLogger('fixture').emit({ context: trace.setSpanContext(ROOT_CONTEXT, span.spanContext()), severityNumber: 17,
    body: 'mikka.stage.failed', attributes: { 'mikka.stage': 'daemon.run', token: 'private token' } })
  await Promise.all([tracer.forceFlush(), logger.forceFlush()])
  const decodedSpans = decodeOtlp(Buffer.from(ProtobufTraceSerializer.serializeRequest(traces.getFinishedSpans())), 'traces')
  const decodedLogs = decodeOtlp(Buffer.from(ProtobufLogsSerializer.serializeRequest(logs.getFinishedLogRecords())), 'logs')
  assert.equal(decodedSpans[0].traceId, span.spanContext().traceId)
  assert.equal(decodedSpans[0].status, 2)
  assert.equal(decodedSpans[0].attributes['mikka.ai.input_tokens'], 12)
  assert.equal(decodedLogs[0].traceId, span.spanContext().traceId)
  assert.equal(decodedLogs[0].spanId, span.spanContext().spanId)
  assert.equal(decodedLogs[0].severity, 17)
  assert.equal(decodedLogs[0].body, 'mikka.stage.failed')
  assert.ok(!JSON.stringify([decodedSpans, decodedLogs]).includes('private'))
  await Promise.all([tracer.shutdown(), logger.shutdown()])
})
