import assert from 'node:assert/strict'
import test from 'node:test'
import { SpanStatusCode } from '@opentelemetry/api'
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { createLogProvider } from './logs'
import { createTracerProvider, SafeExporter } from './node'
import { CodedError } from '@mikka/protocol/coded-error'
import { safeErrorAttributes } from '@mikka/protocol/tracing'

test('Workflow and failure logs share OTel trace/span IDs and exclude content', async () => {
  const logMemory = new InMemoryLogRecordExporter()
  const logs = createLogProvider({ endpoint: 'https://unused.test/i/v1/traces', token: 'unused', environment: 'dev', exporter: logMemory })
  const spans = new InMemorySpanExporter()
  const provider = createTracerProvider({ exporter: new SafeExporter(spans), sampleRate: 1, environment: 'dev', logger: logs.getLogger('test') })
  const span = provider.getTracer('test').startSpan('workflow.coordinator', { attributes: { 'mikka.run_id': 'run_1512', sessionId: 'session_1512', prompt: 'private prompt', authorization: 'Bearer private' } })
  span.setAttributes(safeErrorAttributes(new CodedError('trace_acceptance_failed', { cause: Object.assign(new Error('private output'), { code: 'ECONNRESET' }) })))
  span.setStatus({ code: SpanStatusCode.ERROR, message: 'private output' })
  span.end()
  await provider.forceFlush(); await logs.forceFlush()
  const [record] = logMemory.getFinishedLogRecords()
  assert.equal(record.spanContext?.traceId, span.spanContext().traceId)
  assert.equal(record.spanContext?.spanId, span.spanContext().spanId)
  assert.equal(record.body, 'mikka.stage.failed')
  assert.equal(record.attributes['mikka.error.causes'], 'CodedError:trace_acceptance_failed > Error:ECONNRESET')
  assert.equal(record.attributes.sessionId, 'session_1512')
  assert.equal(JSON.stringify({ body: record.body, attributes: record.attributes }).includes('private'), false)
  await provider.shutdown(); await logs.shutdown()
})

test('tail-retained ordinary failures give native Logs the same effective rate as APM', async () => {
  const logMemory = new InMemoryLogRecordExporter(), spans = new InMemorySpanExporter()
  const logs = createLogProvider({ endpoint: 'https://unused.test/i/v1/traces', token: 'unused', environment: 'dev', exporter: logMemory })
  const provider = createTracerProvider({ exporter: new SafeExporter(spans), sampleRate: 0.000001, environment: 'dev', logger: logs.getLogger('test') })
  try {
    const span = provider.getTracer('test').startSpan('GET /api/ordinary')
    span.setStatus({ code: SpanStatusCode.ERROR }); span.end()
    await provider.forceFlush(); await logs.forceFlush()
    const [saved] = spans.getFinishedSpans(), [record] = logMemory.getFinishedLogRecords()
    assert.equal(saved.attributes['mikka.trace.sample_rate'], 1)
    assert.equal(record.attributes['mikka.trace.sample_rate'], 1)
    assert.equal(record.attributes['mikka.trace.retention'], 'error_or_slow')
    assert.equal(record.spanContext?.traceId, saved.spanContext().traceId)
    assert.equal(record.spanContext?.spanId, saved.spanContext().spanId)
    assert.equal(record.spanContext?.traceFlags, saved.spanContext().traceFlags)
  } finally { await provider.shutdown(); await logs.shutdown() }
})
