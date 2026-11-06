import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { AlwaysOnSampler, BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { LoggerProvider, SimpleLogRecordProcessor, InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import { decodeOtlp } from './trace-collector.mjs'

// Test the small collector reader against the installed official exporter
// serializers, including binary IDs, typed attributes and log span context.
const require = createRequire(import.meta.url)
const { ProtobufTraceSerializer, ProtobufLogsSerializer } = require(require.resolve('@opentelemetry/otlp-transformer', {
  paths: [dirname(require.resolve('@opentelemetry/exporter-trace-otlp-proto'))],
}))
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
