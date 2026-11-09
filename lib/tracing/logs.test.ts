import assert from 'node:assert/strict'
import test from 'node:test'
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base'
import { createLogProvider } from './logs'
import { createTracerProvider, SafeExporter } from './node'
import { CodedError } from '@mikka/protocol/coded-error'
import { safeErrorAttributes } from '@mikka/protocol/tracing'
import { registerTelemetryFlush } from './flush'
import { withRunSpan } from './context'
import { observeAiRequest } from './ai'
import { createApiHandler } from '../../apps/api/src/application'
import { beginRequestTrace } from '../../apps/api/runtime/request-trace'
import { decodeOtlp } from '../../tests/mvp/trace-collector.mjs'

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


// Use the pinned SDK's real serializer and Workflow tracing helper. Transport
// completion is local and controlled; this fixture never opens a socket.
test('HTTP completes while waitUntil retains an earlier in-flight Workflow trace export', async t => {
  const require = createRequire(import.meta.url)
  const exporterRequire = createRequire(require.resolve('@opentelemetry/exporter-trace-otlp-proto'))
  const { ProtobufTraceSerializer } = exporterRequire('@opentelemetry/otlp-transformer')
  const workflowRequire = createRequire(require.resolve('workflow'))
  const official = await import(pathToFileURL(join(dirname(workflowRequire.resolve('@workflow/core')), 'telemetry.js')).href)
  const delivered: ReturnType<typeof decodeOtlp> = []
  const logMemory = new InMemoryLogRecordExporter()
  const logs = createLogProvider({ endpoint: 'https://unused.test/i/v1/traces', token: 'unused', environment: 'dev', exporter: logMemory })
  const pending = new Set<Promise<void>>()
  let release: (() => void) | undefined, sent = 0, completed = 0, flushCalls = 0
  const sink: SpanExporter = {
    export(spans: ReadableSpan[], done: (result: ExportResult) => void) {
      sent++
      const decoded = decodeOtlp(Buffer.from(ProtobufTraceSerializer.serializeRequest(spans)), 'traces')
      const complete = () => { delivered.push(...decoded); completed++; done({ code: ExportResultCode.SUCCESS }) }
      if (sent !== 1) { complete(); return }
      const deferred = Promise.withResolvers<void>()
      pending.add(deferred.promise)
      release = () => { complete(); pending.delete(deferred.promise); deferred.resolve() }
    },
    forceFlush: async () => { flushCalls++; await Promise.all(pending) },
    shutdown: async () => { await Promise.all(pending) },
  }
  const provider = createTracerProvider({ exporter: new SafeExporter(sink), sampleRate: 0.1, environment: 'dev', logger: logs.getLogger('test'), serverless: true })
  const key = Symbol.for('@vercel/request-context'), previous = Object.getOwnPropertyDescriptor(globalThis, key)
  const lifetimes: Promise<unknown>[] = []
  Object.defineProperty(globalThis, key, { configurable: true, value: { get: () => ({ waitUntil: (value: Promise<unknown>) => lifetimes.push(value) }) } })
  const unregister = registerTelemetryFlush(() => logs.forceFlush())
  provider.register()
  try {
    const captured: unknown[] = [], disposed = Promise.withResolvers<void>()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const app = createApiHandler([{
      path: '/mikka/api/trace-flush-fixture', template: '/api/trace-flush-fixture', source: 'fixture', methods: ['POST'],
      load: async () => ({ POST: async () => {
        await official.trace('step.execute fixture', async (span: { setAttribute(key: string, value: string): void }) => {
          span.setAttribute('workflow.run.id', 'wrun_local_export_fixture')
          await observeAiRequest({ modelId: 'fixture-model', route: 'subscription', operation: 'bot', posthog: { capture: event => { captured.push(event) } } },
            async receipt => { receipt({ usage: { inputTokens: 5, outputTokens: 1 } }); return undefined })
          await withRunSpan('dispatch_run', {}, () => withRunSpan('dispatch.resolveRepository', {}, async () => undefined))
        })
        t.mock.timers.tick(5000)
        assert.equal(pending.size, 1)
        return new Response('business response')
      } }),
    }], (request, route) => {
      const active = beginRequestTrace(request, route)
      return { ...active, finish(status, error) { active.finish(status, error); disposed.resolve() } }
    })
    const response = await app.fetch(new Request('https://mikka.test/mikka/api/trace-flush-fixture', { method: 'POST' }))
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'business response', 'response disposal does not await the transport')
    await disposed.promise
    assert.equal(pending.size, 1)
    assert.equal(lifetimes.length, 1)
    let settled = false
    const lifetime = Promise.all(lifetimes).then(() => { settled = true })
    await nextTurn()
    await logs.forceFlush()
    assert.equal(captured.length, 1)
    assert.equal(sent, 2); assert.equal(completed, 1)
    assert.deepEqual(delivered.map(span => span.name), ['POST /api/trace-flush-fixture'])
    assert.deepEqual(logMemory.getFinishedLogRecords().map(record => record.attributes['mikka.stage']).sort(), ['dispatch.resolveRepository', 'dispatch_run', 'step.execute'])
    assert.equal(settled, false, 'waitUntil must also retain the earlier export already removed from the batch queue')
    assert.equal(flushCalls, 1)
    release!()
    await lifetime
    assert.equal(pending.size, 0); assert.equal(completed, 2)
    assert.equal(delivered.length, 5)
    assert.equal(delivered.filter(span => span.name === 'mikka.ai.generation').length, 1)
    assert.equal(delivered.filter(span => {
      assert.ok(typeof span.name === 'string')
      return span.name.startsWith('dispatch')
    }).length, 2)
    assert.equal(new Set(delivered.map(span => span.spanId)).size, 5)
  } finally {
    if (pending.size) release?.()
    t.mock.timers.reset(); unregister()
    await provider.shutdown(); await logs.shutdown()
    trace.disable(); context.disable(); propagation.disable()
    if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key)
  }
})

for (const failure of ['reject', 'throw'] as const) test(`exporter forceFlush ${failure} does not fail the HTTP response or retained lifetime`, async () => {
  let calls = 0
  const sink: SpanExporter = {
    export(_spans, done) { done({ code: ExportResultCode.SUCCESS }) },
    forceFlush() { calls++; if (failure === 'throw') throw new Error('fixture'); return Promise.reject(new Error('fixture')) },
    shutdown: async () => {},
  }
  const provider = createTracerProvider({ exporter: new SafeExporter(sink), sampleRate: 1, environment: 'dev', serverless: true })
  const key = Symbol.for('@vercel/request-context'), previous = Object.getOwnPropertyDescriptor(globalThis, key)
  const lifetimes: Promise<unknown>[] = []
  Object.defineProperty(globalThis, key, { configurable: true, value: { get: () => ({ waitUntil: (value: Promise<unknown>) => lifetimes.push(value) }) } })
  provider.register()
  try {
    const disposed = Promise.withResolvers<void>()
    const app = createApiHandler([{
      path: '/mikka/api/trace-flush-fixture', template: '/api/trace-flush-fixture', source: 'fixture', methods: ['POST'],
      load: async () => ({ POST: () => new Response('business response') }),
    }], (request, route) => {
      const active = beginRequestTrace(request, route)
      return { ...active, finish(status, error) { active.finish(status, error); disposed.resolve() } }
    })
    const response = await app.fetch(new Request('https://mikka.test/mikka/api/trace-flush-fixture', { method: 'POST' }))
    assert.equal(response.status, 200); assert.equal(await response.text(), 'business response')
    await disposed.promise
    assert.equal(lifetimes.length, 1)
    await Promise.all(lifetimes)
    assert.equal(calls, 1)
  } finally {
    await provider.shutdown()
    trace.disable(); context.disable(); propagation.disable()
    if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key)
  }
})
