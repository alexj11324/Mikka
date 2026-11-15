import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { beginRequestTrace } from '../../apps/api/runtime/request-trace'
import { captureTraceContext, RunContextPropagator, withRunSpan, withTraceContext } from './context'
import { createTracerProvider, SafeExporter } from './node'
import { runJob } from './jobs'
import { CodedError } from '@mikka/protocol/coded-error'
import { afterJob } from '../background'

const memory = new InMemorySpanExporter()
const provider = createTracerProvider({ exporter: new SafeExporter(memory), sampleRate: 0.000001, environment: 'dev' })
before(() => provider.register({ propagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new RunContextPropagator()] }) }))
after(async () => { await provider.shutdown(); trace.disable(); context.disable(); propagation.disable() })

test('request, deferred job, durable queue carrier and remote run share ancestry and safe session metadata', async () => {
  memory.reset()
  const request = beginRequestTrace(new Request('https://mikka.test/api/coordinator/messages', { method: 'POST', headers: {
    'x-posthog-distinct-id': 'opaque_user_123', 'x-posthog-session-id': '01234567-89ab-cdef-0123-456789abcdef',
    authorization: 'Bearer never-export-me', baggage: 'private=never-export-me',
  } }), '/api/coordinator/messages')
  let carrier: Record<string, string> = {}
  await request.run(async () => {
    request.finish(200)
    await runJob('after:coordinator-wake', 'background', async () => {
      propagation.inject(context.active(), carrier)
    })
  })
  assert.ok(carrier.traceparent)
  assert.equal(carrier.baggage, undefined)
  await context.with(propagation.extract(ROOT_CONTEXT, carrier), () => withRunSpan('workflow.coordinator', {}, async () => {
    const saved = captureTraceContext({ runId: '11111111-1111-4111-8111-111111111111', taskId: '22222222-2222-4222-8222-222222222222' })
    assert.equal(saved?.sampleRate, 1)
    await context.with(ROOT_CONTEXT, () => withTraceContext(saved, () => withRunSpan('daemon.run', {}, () => undefined)))
  }))
  await provider.forceFlush()
  const spans = memory.getFinishedSpans()
  assert.equal(spans.length, 4)
  assert.equal(new Set(spans.map(s => s.spanContext().traceId)).size, 1)
  const byName = new Map(spans.map(s => [s.name, s]))
  assert.equal(byName.get('after:coordinator-wake')!.parentSpanContext?.spanId, byName.get('POST /api/coordinator/messages')!.spanContext().spanId)
  assert.equal(byName.get('workflow.coordinator')!.parentSpanContext?.spanId, byName.get('after:coordinator-wake')!.spanContext().spanId)
  assert.equal(byName.get('daemon.run')!.parentSpanContext?.spanId, byName.get('workflow.coordinator')!.spanContext().spanId)
  for (const span of spans) {
    assert.equal(span.attributes.posthogDistinctId, 'opaque_user_123')
    assert.equal(span.attributes.sessionId, '01234567-89ab-cdef-0123-456789abcdef')
  }
  assert.equal(byName.get('daemon.run')!.attributes['mikka.run_id'], '11111111-1111-4111-8111-111111111111')
  assert.equal(JSON.stringify(spans.map(s => s.attributes)).includes('never-export-me'), false)
})

test('ordinary errors and slow requests retain their local child timeline; fast success stays sampled', async () => {
  const parent = propagation.extract(ROOT_CONTEXT, { traceparent: '00-ffffffff000000000000000000000000-1234567890abcdef-00' })
  for (const outcome of ['fast', 'error', 'refused', 'slow'] as const) {
    memory.reset()
    await context.with(parent, () => provider.getTracer('ordinary').startActiveSpan('GET /api/issues', { kind: SpanKind.SERVER, startTime: [100, 0] }, async span => {
      provider.getTracer('ordinary').startSpan('db.query', { startTime: [100, 1] }).end([100, 2])
      if (outcome === 'error') span.setStatus({ code: SpanStatusCode.ERROR })
      if (outcome === 'refused') span.setAttribute('http.response.status_code', 403)
      span.end(outcome === 'slow' ? [102, 0] : [100, 1000])
    }))
    await provider.forceFlush()
    assert.equal(memory.getFinishedSpans().length, outcome === 'fast' ? 0 : 2)
  }
})

test('an after scheduler without an async context still keeps the scheduling request', async () => {
  memory.reset()
  const request = beginRequestTrace(new Request('https://mikka.test/api/coordinator/messages', { method: 'POST' }), '/api/coordinator/messages')
  let scheduled: (() => unknown) | undefined
  request.run(() => afterJob('after:coordinator-wake', () => undefined, { schedule: job => { scheduled = job } }))
  request.finish(202)
  await context.with(ROOT_CONTEXT, () => scheduled!())
  await provider.forceFlush()
  const spans = memory.getFinishedSpans()
  assert.equal(spans.length, 2)
  assert.equal(new Set(spans.map(span => span.spanContext().traceId)).size, 1)
  const root = spans.find(span => span.name.startsWith('POST'))!
  assert.equal(spans.find(span => span.name.startsWith('after:'))?.parentSpanContext?.spanId, root.spanContext().spanId)
})

test('head-sampled ordinary failures use effective rate one for the entire local tree', async () => {
  const parent = propagation.extract(ROOT_CONTEXT, { traceparent: '00-00000000000000000000000000000001-1234567890abcdef-00' })
  for (const outcome of ['fast', 'error', 'slow'] as const) {
    memory.reset()
    context.with(parent, () => provider.getTracer('ordinary').startActiveSpan('GET /api/issues', { startTime: [100, 0] }, span => {
      assert.equal(span.spanContext().traceFlags, 1)
      provider.getTracer('ordinary').startSpan('db.query', { startTime: [100, 1] }).end([100, 2])
      if (outcome === 'error') span.setStatus({ code: SpanStatusCode.ERROR })
      span.end(outcome === 'slow' ? [102, 0] : [100, 1000])
    }))
    await provider.forceFlush()
    const saved = memory.getFinishedSpans()
    assert.equal(saved.length, 2)
    assert.ok(saved.every(span => span.attributes['mikka.trace.sample_rate'] === (outcome === 'fast' ? 0.000001 : 1)))
  }
})

test('a critical failure is retained, preserves safe cause detail and never exports the message', async () => {
  memory.reset()
  await assert.rejects(withRunSpan('dispatch_run', {}, async () => {
    throw new CodedError('run_trace_acceptance_failed', { detail: 'injected_collector_test', cause: Object.assign(new Error('private user prompt and sk-secret'), { code: 'ECONNRESET' }) })
  }))
  await provider.forceFlush()
  const [span] = memory.getFinishedSpans()
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.equal(span.attributes['mikka.error.detail'], 'injected_collector_test')
  assert.equal(JSON.stringify(span.attributes).includes('private user'), false)
})

test('durable SDK stage labels and run identity survive attributes added after span start', async () => {
  memory.reset()
  const span = provider.getTracer('workflow').startSpan('step.execute step//./workflows/run-publication/steps//publishResult')
  span.setAttributes({
    'workflow.run.id': 'wrun_12345', 'workflow.name': 'workflow//./workflows/run-publication//runPublicationWorkflow',
    'step.name': 'step//./workflows/run-publication/steps//publishResult', 'step.input': 'private prompt',
  })
  span.end()
  await provider.forceFlush()
  const [saved] = memory.getFinishedSpans()
  assert.equal(saved.name, 'step.execute')
  assert.equal(saved.attributes['mikka.workflow_run_id'], 'wrun_12345')
  assert.equal(saved.attributes['mikka.workflow'], 'runPublicationWorkflow')
  assert.equal(saved.attributes['mikka.step'], 'publishResult')
  assert.equal(saved.attributes['step.input'], undefined)
})
