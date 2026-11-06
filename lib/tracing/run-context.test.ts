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
    }, { detach: true })
  })
  assert.ok(carrier.traceparent)
  assert.equal(carrier.baggage, undefined)
  await context.with(propagation.extract(ROOT_CONTEXT, carrier), () => withRunSpan('workflow.coordinator', {}, async () => {
    const saved = captureTraceContext({ runId: '11111111-1111-4111-8111-111111111111', taskId: '22222222-2222-4222-8222-222222222222' })
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
  for (const outcome of ['fast', 'error', 'slow'] as const) {
    memory.reset()
    await context.with(parent, () => provider.getTracer('ordinary').startActiveSpan('GET /api/issues', { kind: SpanKind.SERVER, startTime: [100, 0] }, async span => {
      provider.getTracer('ordinary').startSpan('db.query', { startTime: [100, 1] }).end([100, 2])
      if (outcome === 'error') span.setStatus({ code: SpanStatusCode.ERROR })
      span.end(outcome === 'slow' ? [102, 0] : [100, 1000])
    }))
    await provider.forceFlush()
    assert.equal(memory.getFinishedSpans().length, outcome === 'fast' ? 0 : 2)
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
