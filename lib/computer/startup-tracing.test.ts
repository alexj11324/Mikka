import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { SafeExporter, createTracerProvider } from '../tracing/node'
import { cloudStartupPhases, cloudStartupRunAttributes, cloudStartupSpan, recordCloudBootstrapPhases } from './startup-tracing'

const memory = new InMemorySpanExporter()
const provider = createTracerProvider({ exporter: new SafeExporter(memory), sampleRate: 1, environment: 'dev' })
before(() => provider.register())
after(async () => { await provider.shutdown(); trace.disable(); context.disable(); propagation.disable() })

test('startup phases preserve their parent and expose only a hashed run identity', async () => {
  memory.reset()
  const runId = '15050000-0000-4000-8000-000000000001'
  const attributes = cloudStartupRunAttributes(runId)
  const value = await cloudStartupSpan('cloud.thread.ensure', attributes, async () => {
    const phases = cloudStartupPhases(attributes)
    phases.next('admission')
    await Promise.resolve()
    phases.next('connect')
    await cloudStartupSpan('cloud.sandbox.create', attributes, async () => 7)
    phases.end()
    return 42
  })
  await provider.forceFlush()
  assert.equal(value, 42)
  const spans = memory.getFinishedSpans()
  const parent = spans.find(span => span.name === 'cloud.thread.ensure')!
  assert.equal(spans.length, 4)
  for (const span of spans) {
    assert.equal(span.attributes['mikka.run.id_hash'], attributes['mikka.run.id_hash'])
    if (span !== parent) assert.equal(span.parentSpanContext?.spanId, parent.spanContext().spanId)
    assert.ok(span.duration[0] >= 0)
  }
  assert.ok(!JSON.stringify(spans.map(span => span.attributes)).includes(runId))
})

test('failed provisioning preserves the original error without publishing its message', async () => {
  memory.reset()
  const failure = new Error('private credential must never reach a trace')
  await assert.rejects(cloudStartupSpan('cloud.sandbox.create', {}, async () => { throw failure }), error => error === failure)
  await provider.forceFlush()
  const [span] = memory.getFinishedSpans()
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.ok(!JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }).includes(failure.message))
})

test('remote bootstrap receipts produce exact phase durations without exporting command output', async () => {
  memory.reset()
  const startedAt = Date.now() - 5_000
  await cloudStartupSpan('cloud.sandbox.bootstrap', {}, async () => {
    recordCloudBootstrapPhases('private package-manager output\nmikka-bootstrap-phase source 1200\nmikka-bootstrap-phase secret_token 100\nmikka-bootstrap-phase dependencies 2500\n', startedAt, startedAt + 4_000)
  })
  await provider.forceFlush()
  const spans = memory.getFinishedSpans()
  const parent = spans.find(span => span.name === 'cloud.sandbox.bootstrap')!
  const stages = spans.filter(span => span !== parent)
  assert.deepEqual(stages.map(span => [span.name, span.duration]), [
    ['cloud.bootstrap.source', [1, 200_000_000]],
    ['cloud.bootstrap.dependencies', [2, 500_000_000]],
  ])
  assert.ok(stages.every(span => span.parentSpanContext?.spanId === parent.spanContext().spanId))
  assert.ok(!JSON.stringify(stages.map(span => ({ name: span.name, attributes: span.attributes }))).includes('private'))
})
