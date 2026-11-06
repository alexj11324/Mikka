import { afterEach, describe, expect, it } from 'vitest'
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace, type Context } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { DaemonRetainingSpanProcessor, DaemonSampler, RUN_CONTEXT, SLOW_OPERATION_MS } from './tracing-sampling'
import { cleanAttributes, SafeExporter } from './tracing'
import { StageLogProcessor } from './tracing-logs'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())) })
const lowId = '00000000000000000000000000000001', highId = 'ffffffff000000000000000000000001'

function observed(headSelected = false, limits?: { traces: number; spans: number }) {
  const spans = new InMemorySpanExporter(), logs = new InMemoryLogRecordExporter()
  const logProvider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logs })] })
  let ids = 0
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'mikka-daemon' }),
    sampler: new DaemonSampler(0.1),
    idGenerator: { generateTraceId: () => headSelected ? lowId : highId, generateSpanId: () => (++ids).toString(16).padStart(16, '0') },
    spanProcessors: [new DaemonRetainingSpanProcessor([
      new SimpleSpanProcessor(new SafeExporter(spans)), new StageLogProcessor(logProvider.getLogger('test'), cleanAttributes),
    ], limits?.traces, limits?.spans)],
  })
  cleanup.push(async () => { await provider.shutdown(); await logProvider.shutdown() })
  return { tracer: provider.getTracer('test'), spans, logs, async flush() { await provider.forceFlush(); await logProvider.forceFlush() } }
}

function remote(sampleRate?: number, sampled = true): Context {
  const span = { traceId: highId, spanId: '0123456789abcdef', traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE, isRemote: true }
  return trace.setSpanContext(ROOT_CONTEXT, span).setValue(RUN_CONTEXT, {
    traceparent: `00-${span.traceId}-${span.spanId}-${sampled ? '01' : '00'}`, ...(sampleRate === undefined ? {} : { sampleRate }),
  })
}

describe('daemon sampling weights and local tail retention', () => {
  for (const headSelected of [false, true]) for (const outcome of ['error', 'http_failure', 'slow'] as const) {
    it(`retains the whole ${headSelected ? 'head-selected' : 'initially unsampled'} local ${outcome} tree at weight one, including logs`, async () => {
      const observedTree = observed(headSelected), started = Date.now()
      const root = observedTree.tracer.startSpan('daemon.gateway.connect', { startTime: new Date(started) }, ROOT_CONTEXT)
      const child = observedTree.tracer.startSpan('GET /v1/devices/[id]/repos', {}, trace.setSpan(ROOT_CONTEXT, root))
      expect(child.isRecording()).toBe(true)
      expect(Boolean(child.spanContext().traceFlags & TraceFlags.SAMPLED)).toBe(headSelected)
      if (outcome === 'error') child.setStatus({ code: SpanStatusCode.ERROR })
      if (outcome === 'http_failure') child.setAttribute('http.response.status_code', 503)
      child.end(new Date(started + 10))
      await observedTree.flush()
      expect(observedTree.spans.getFinishedSpans()).toHaveLength(0)
      expect(observedTree.logs.getFinishedLogRecords()).toHaveLength(0)
      root.end(new Date(started + (outcome === 'slow' ? SLOW_OPERATION_MS + 1 : 25)))
      await observedTree.flush()
      const saved = observedTree.spans.getFinishedSpans(), logs = observedTree.logs.getFinishedLogRecords()
      expect(saved).toHaveLength(2)
      expect(saved.every(span => span.attributes['mikka.trace.sample_rate'] === 1
        && span.attributes['mikka.trace.retention'] === 'error_or_slow'
        && Boolean(span.spanContext().traceFlags & TraceFlags.SAMPLED))).toBe(true)
      expect(logs.length).toBeGreaterThan(0)
      expect(logs.every(log => log.attributes['mikka.trace.sample_rate'] === 1 && log.attributes['mikka.trace.retention'] === 'error_or_slow')).toBe(true)
      expect(logs.every(log => saved.some(span => span.spanContext().spanId === log.spanContext?.spanId))).toBe(true)
    })
  }

  for (const headSelected of [false, true]) it(`keeps the real configured weight for a fast ordinary ${headSelected ? 'selected' : 'discarded'} tree`, async () => {
    const tree = observed(headSelected)
    const root = tree.tracer.startSpan('daemon.gateway.connect', {}, ROOT_CONTEXT)
    const child = tree.tracer.startSpan('GET /v1/devices/[id]/repos', {}, trace.setSpan(ROOT_CONTEXT, root))
    child.end(); root.end(); await tree.flush()
    expect(tree.spans.getFinishedSpans()).toHaveLength(headSelected ? 2 : 0)
    expect(tree.logs.getFinishedLogRecords()).toHaveLength(headSelected ? 1 : 0)
    for (const span of tree.spans.getFinishedSpans()) expect(span.attributes).toMatchObject({
      'mikka.trace.sample_rate': 0.1, 'mikka.trace.retention': 'head', 'mikka.trace.critical': false,
    })
  })

  it('inherits a known remote rate without applying the daemon ratio or promoting already-sampled upstream errors', async () => {
    const tree = observed()
    const root = tree.tracer.startSpan('daemon.gateway.connect', {}, remote(0.25))
    const child = tree.tracer.startSpan('GET /v1/devices/[id]/repos', {}, trace.setSpan(ROOT_CONTEXT, root))
    child.setStatus({ code: SpanStatusCode.ERROR }); child.end(); root.end(); await tree.flush()
    expect(tree.spans.getFinishedSpans()).toHaveLength(2)
    for (const item of [...tree.spans.getFinishedSpans(), ...tree.logs.getFinishedLogRecords()]) {
      expect(item.attributes['mikka.trace.sample_rate']).toBe(0.25)
      expect(item.attributes['mikka.trace.retention']).toBe('parent')
    }
  })

  it('never invents a rate from an unfamiliar sampled remote trace flag, even on an error', async () => {
    const tree = observed()
    const root = tree.tracer.startSpan('daemon.run', {}, remote())
    const child = tree.tracer.startSpan('daemon.adapter.start', {}, trace.setSpan(ROOT_CONTEXT, root))
    child.setStatus({ code: SpanStatusCode.ERROR }); child.end(); root.end(); await tree.flush()
    expect(tree.spans.getFinishedSpans()).toHaveLength(2)
    for (const item of [...tree.spans.getFinishedSpans(), ...tree.logs.getFinishedLogRecords()]) {
      expect(item.attributes).not.toHaveProperty('mikka.trace.sample_rate')
      expect(item.attributes['mikka.trace.retention']).toBe('parent_unknown')
    }
  })

  it('preserves an unsampled remote parent and never claims its error tree was complete', async () => {
    const tree = observed()
    const root = tree.tracer.startSpan('daemon.run', {}, remote(0.25, false))
    const child = tree.tracer.startSpan('daemon.adapter.start', {}, trace.setSpan(ROOT_CONTEXT, root))
    expect(root.isRecording()).toBe(false)
    expect(child.isRecording()).toBe(false)
    child.setStatus({ code: SpanStatusCode.ERROR }); child.end(); root.end(); await tree.flush()
    expect(tree.spans.getFinishedSpans()).toHaveLength(0)
    expect(tree.logs.getFinishedLogRecords()).toHaveLength(0)
  })

  it('drops an over-capacity local tree without leaking a partial tree or blocking later work', async () => {
    const tree = observed(true, { traces: 1, spans: 2 })
    const root = tree.tracer.startSpan('daemon.gateway.connect', {}, ROOT_CONTEXT)
    const child = tree.tracer.startSpan('child', {}, trace.setSpan(ROOT_CONTEXT, root))
    const overflow = tree.tracer.startSpan('overflow', {}, trace.setSpan(ROOT_CONTEXT, child))
    overflow.setStatus({ code: SpanStatusCode.ERROR }); overflow.end(); child.end(); root.end(); await tree.flush()
    expect(tree.spans.getFinishedSpans()).toHaveLength(0)
    const next = tree.tracer.startSpan('daemon.gateway.connect', {}, ROOT_CONTEXT)
    next.end(); await tree.flush()
    expect(tree.spans.getFinishedSpans()).toHaveLength(1)
  })

  it('drops invalid sampling attributes at the export boundary', () => {
    expect(cleanAttributes({ 'mikka.trace.sample_rate': Infinity, 'mikka.trace.critical': 'yes', 'mikka.trace.retention': 'private-prompt' })).toEqual({})
    for (const rate of [0, -1, 1.1, '0.1']) expect(cleanAttributes({ 'mikka.trace.sample_rate': rate })).toEqual({})
  })
})
