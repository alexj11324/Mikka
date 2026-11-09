import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { context, propagation, trace } from '@opentelemetry/api'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { createTracerProvider, SafeExporter } from './node'
import { createLogProvider } from './logs'
import { registerTelemetryFlush } from './flush'
import { withRunSpan } from './context'
import { observeAiRequest } from './ai'
import { decodeOtlp } from '../../tests/mvp/trace-collector.mjs'

// Exact M1 production provider + official pinned Workflow telemetry helper and
// official OTLP protobuf serialization. Only the transport completion is held.
// No socket, HTTP request, PostHog ingestion, database, model or cloud resource.
const require = createRequire(import.meta.url)
const exporterRequire = createRequire(require.resolve('@opentelemetry/exporter-trace-otlp-proto'))
const { ProtobufTraceSerializer } = exporterRequire('@opentelemetry/otlp-transformer')
const workflowRequire = createRequire(require.resolve('workflow'))
const telemetryUrl = pathToFileURL(join(dirname(workflowRequire.resolve('@workflow/core')), 'telemetry.js')).href

test('serverless completion retains an already-started trace export until its callback settles', async t => {
  const delivered: ReturnType<typeof decodeOtlp> = []
  const logMemory = new InMemoryLogRecordExporter()
  const logs = createLogProvider({ endpoint: 'https://fixture.invalid/i/v1/traces', token: 'fixture-unused', environment: 'production', version: '01a6bfb3a6c5', exporter: logMemory })
  const pending = new Set<Promise<void>>()
  let delayNext = false, release: (() => void) | undefined
  let sentBatches = 0, completedBatches = 0, innerFlushCalls = 0
  const sink: SpanExporter = {
    export(spans: ReadableSpan[], done: (result: ExportResult) => void) {
      sentBatches++
      const bytes = ProtobufTraceSerializer.serializeRequest(spans)
      assert.ok(bytes && bytes.byteLength > 0)
      const decoded = decodeOtlp(Buffer.from(bytes), 'traces')
      const complete = () => { delivered.push(...decoded); completedBatches++; done({ code: ExportResultCode.SUCCESS }) }
      if (!delayNext) { complete(); return }
      delayNext = false
      const deferred = Promise.withResolvers<void>()
      pending.add(deferred.promise)
      release = () => { complete(); pending.delete(deferred.promise); deferred.resolve() }
    },
    forceFlush: async () => { innerFlushCalls++; await Promise.all([...pending]) },
    shutdown: async () => { await Promise.all([...pending]) },
  }
  const provider = createTracerProvider({ exporter: new SafeExporter(sink), sampleRate: 0.1, environment: 'production', version: '01a6bfb3a6c5', logger: logs.getLogger('probe'), serverless: true })
  const key = Symbol.for('@vercel/request-context')
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  const lifetimes: Promise<unknown>[] = []
  Object.defineProperty(globalThis, key, { configurable: true, value: { get: () => ({ waitUntil: (value: Promise<unknown>) => lifetimes.push(value) }) } })
  const unregister = registerTelemetryFlush(() => logs.forceFlush())
  provider.register()
  try {
    const official = await import(telemetryUrl)
    const ai: Array<{ properties?: Record<string, unknown> }> = []
    const root = provider.getTracer('probe').startSpan('POST /.well-known/workflow/v1/step', { attributes: { 'mikka.trace.critical': true } })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    await context.with(trace.setSpan(context.active(), root), () =>
      official.trace('step.execute fixture', async (step: { setAttribute(key: string, value: string): void }) => {
        step.setAttribute('workflow.run.id', 'wrun_local_export_fixture')
        await observeAiRequest({ modelId: 'fixture-model', route: 'subscription', operation: 'bot', posthog: { capture: (event: { properties?: Record<string, unknown> }) => ai.push(event) } },
          async receipt => { receipt({ usage: { inputTokens: 5, outputTokens: 1 } }); return undefined })
        await withRunSpan('dispatch_run', {}, () => withRunSpan('dispatch.resolveRepository', {}, async () => undefined))
      }))
    // The real batch timer begins one export before the request root finishes.
    delayNext = true
    t.mock.timers.tick(5000)
    assert.equal(pending.size, 1)
    assert.equal(sentBatches, 1)
    assert.equal(ai.length, 1)
    root.end()
    assert.equal(lifetimes.length, 1)
    let lifetimeSettled = false
    const lifetime = Promise.all(lifetimes).then(() => { lifetimeSettled = true })
    await nextTurn()
    await logs.forceFlush()
    const observed = {
      fixtureBoundary: 'Exact M1 createTracerProvider + official Workflow helper + official OTLP serializer; deferred local exporter callback, no network',
      sourceRevision: '01a6bfb3a6c537e2b466911f57429f109b418aa8',
      sentBatches, completedBatches, pendingBatches: pending.size, innerFlushCalls,
      waitUntilSettledWhileEarlierBatchPending: lifetimeSettled,
      deliveredSpanNames: delivered.map(span => span.name),
      stageLogNames: logMemory.getFinishedLogRecords().map(record => record.attributes['mikka.stage']),
      capturedAiEvents: ai.length,
    }
    console.info('PROBE_RECEIPT ' + JSON.stringify(observed))
    assert.equal(lifetimeSettled, false, 'The production waitUntil lifetime must retain an earlier in-flight trace export, not only the currently queued root')
    release!()
    await lifetime
    assert.equal(pending.size, 0)
    assert.equal(delivered.filter(span => span.name === 'mikka.ai.generation').length, 1)
    assert.equal(delivered.filter(span => span.name.startsWith('dispatch')).length, 2)
    assert.equal(delivered.filter(span => span.name === 'step.execute').length, 1)
    console.info('PROBE_COMPLETED ' + JSON.stringify({ deliveredSpans: delivered.length, completedBatches, innerFlushCalls }))
  } finally {
    release?.()
    t.mock.timers.reset()
    unregister()
    await provider.shutdown(); await logs.shutdown()
    trace.disable(); context.disable(); propagation.disable()
    if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key)
  }
})

