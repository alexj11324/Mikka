import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { mobileTraceHeaders } from '../../packages/protocol/src/trace-context'
import { requestClientAttributes, withRequestLog } from '../request-log'
import { SafeExporter, createTracerProvider } from './node'

const memory = new InMemorySpanExporter()
const provider = createTracerProvider({ exporter: new SafeExporter(memory), sampleRate: 1, environment: 'dev' })
before(() => provider.register())
after(async () => { await provider.shutdown(); trace.disable(); context.disable(); propagation.disable() })

test('mobile API context joins the server and database spans with version attribution', async () => {
  memory.reset()
  const headers = mobileTraceHeaders('1.2.3')
  const request = new Request('https://mikka.test/mikka/api/issues', { headers })
  const tracer = provider.getTracer('client-propagation')
  await context.with(propagation.extract(ROOT_CONTEXT, headers), () => tracer.startActiveSpan('GET /api/issues', { kind: SpanKind.SERVER, attributes: { 'http.target': '/mikka/api/issues' } }, async span => {
    await withRequestLog('/api/issues', async () => {
      await Promise.resolve()
      tracer.startSpan('database query').end()
      return new Response('{}')
    }, () => {})(request)
    span.end()
  }))
  await provider.forceFlush()
  const spans = memory.getFinishedSpans()
  assert.equal(spans.length, 2)
  for (const span of spans) {
    assert.equal(span.spanContext().traceId, headers.traceparent.slice(3, 35))
    assert.equal(span.attributes['mikka.client_kind'], 'mobile')
    assert.equal(span.attributes['mikka.app.version'], '1.2.3')
  }
  const server = spans.find(span => span.kind === SpanKind.SERVER)!
  assert.equal(server.parentSpanContext?.spanId, headers.traceparent.slice(36, 52))
  assert.equal(spans.find(span => span.name === 'database query')?.parentSpanContext?.spanId, server.spanContext().spanId)
})

test('mobile attribution stays in its request and cannot overwrite machine routes', async () => {
  memory.reset()
  const tracer = provider.getTracer('client-isolation')
  await Promise.all(['mobile', 'web'].map(kind => context.with(ROOT_CONTEXT, () => tracer.startActiveSpan(kind, { kind: SpanKind.SERVER, attributes: { 'http.target': '/api/issues' } }, async span => {
    await withRequestLog('/api/issues', async () => { await Promise.resolve(); tracer.startSpan(`${kind}-query`).end(); return new Response('{}') }, () => {})(new Request('https://mikka.test/api/issues', { headers: kind === 'mobile' ? mobileTraceHeaders('1.0.0') : {} }))
    span.end()
  }))))
  await provider.forceFlush()
  const spans = memory.getFinishedSpans()
  for (const span of spans) {
    const mobile = span.name.startsWith('mobile')
    assert.equal(span.attributes['mikka.client_kind'], mobile ? 'mobile' : 'web')
    assert.equal(span.attributes['mikka.app.version'], mobile ? '1.0.0' : undefined)
  }
  const request = new Request('https://mikka.test', { headers: mobileTraceHeaders('1.0.0') })
  for (const route of ['/v1/runs/[runId]/events', '/api/cron/recover', '/api/webhooks/github', '/api/runs/mcp/github']) assert.deepEqual(requestClientAttributes(request, route), {})
})

test('untrusted version and unrelated request headers never enter spans', async () => {
  memory.reset()
  const privateValues = ['alice@example.com', '/Users/alex/private', '1.0.0-secret-token']
  const tracer = provider.getTracer('client-privacy')
  for (const version of privateValues) {
    await context.with(ROOT_CONTEXT, () => tracer.startActiveSpan('request', async span => {
      await withRequestLog('/api/issues', () => new Response('{}'), () => {})(new Request('https://mikka.test/api/issues', { headers: { 'x-mikka-client-kind': 'mobile', 'x-mikka-app-version': version, authorization: 'Bearer private-token', cookie: 'session=private-cookie' } }))
      span.end()
    }))
  }
  await provider.forceFlush()
  const payload = JSON.stringify(memory.getFinishedSpans().map(span => ({ attributes: span.attributes, name: span.name })))
  for (const value of [...privateValues, 'private-token', 'private-cookie']) assert.equal(payload.includes(value), false)
  for (const span of memory.getFinishedSpans()) assert.equal(span.attributes['mikka.app.version'], undefined)
})
