import { createContextKey, SpanStatusCode, TraceFlags, trace, type Attributes, type Context } from '@opentelemetry/api'
import { ParentBasedSampler, SamplingDecision, TraceIdRatioBasedSampler, type ReadableSpan, type Sampler, type SamplingResult, type Span, type SpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { RunTraceContext } from '@mikka/protocol/trace-context'

export const RUN_CONTEXT = createContextKey('mikka.daemon.run')
export const SLOW_OPERATION_MS = 1_000
export const RETENTIONS = new Set(['critical', 'head', 'parent', 'parent_unknown', 'error_or_slow'])

export function sampleRate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : undefined
}

export function spanSamplingAttributes(span: unknown): Attributes | undefined {
  return (span as { attributes?: Attributes } | undefined)?.attributes
}

const criticalOperation = (name: string) => /^daemon\.(?:run(?:\.|$)|adapter\.|registration$|bootstrap(?:\.|$))/.test(name)
const samplingAttributes = (rate: number | undefined, critical: boolean, retention: string): Attributes => ({
  ...(rate === undefined ? {} : { 'mikka.trace.sample_rate': rate }),
  'mikka.trace.critical': critical,
  'mikka.trace.retention': retention,
})

/** Parent decisions remain authoritative; only independent local trees use tail retention. */
export class DaemonSampler implements Sampler {
  private readonly delegate: ParentBasedSampler
  constructor(private readonly rate: number) {
    const ratio = new TraceIdRatioBasedSampler(rate)
    const inherited: Sampler = {
      shouldSample(parent, _id, name): SamplingResult {
        const caller = trace.getSpanContext(parent)
        const attributes = spanSamplingAttributes(trace.getSpan(parent))
        const carrier = parent.getValue(RUN_CONTEXT) as RunTraceContext | undefined
        const rate = sampleRate(attributes?.['mikka.trace.sample_rate']) ?? sampleRate(carrier?.sampleRate)
        // Only a locally recorded head tree may continue recording an unsampled
        // parent. A remote unsampled parent is never silently made complete.
        const localTree = !caller?.isRemote && attributes?.['mikka.trace.retention'] === 'head'
        const sampled = Boolean(caller && (caller.traceFlags & TraceFlags.SAMPLED))
        if (!sampled && !localTree) return { decision: SamplingDecision.NOT_RECORD }
        const critical = attributes?.['mikka.trace.critical'] === true
          || Boolean(caller?.isRemote && rate === 1 && (criticalOperation(name) || carrier?.runId || carrier?.workflowRunId))
        const retention = localTree ? 'head' : rate === undefined ? 'parent_unknown'
          : attributes?.['mikka.trace.retention'] === 'critical' ? 'critical' : 'parent'
        return { decision: sampled ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.RECORD,
          attributes: samplingAttributes(rate, critical, retention) }
      },
      toString: () => 'MikkaDaemonInheritedSampler',
    }
    this.delegate = new ParentBasedSampler({
      root: {
        shouldSample(parent, id, name): SamplingResult {
          const critical = criticalOperation(name)
          const retained = critical || ratio.shouldSample(parent, id).decision === SamplingDecision.RECORD_AND_SAMPLED
          return { decision: retained ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.RECORD,
            attributes: samplingAttributes(critical ? 1 : rate, critical, critical ? 'critical' : 'head') }
        },
        toString: () => 'MikkaDaemonCriticalRootSampler',
      },
      localParentSampled: inherited,
      localParentNotSampled: inherited,
      remoteParentSampled: inherited,
      // The SDK's default remoteParentNotSampled stays AlwaysOff.
    })
  }
  shouldSample(...args: Parameters<Sampler['shouldSample']>): SamplingResult {
    return this.rate <= 0 ? { decision: SamplingDecision.NOT_RECORD } : this.delegate.shouldSample(...args)
  }
  toString() { return `MikkaDaemonSampler(${this.rate})` }
}

type Pending = { root: string; open: Set<string>; spans: ReadableSpan[]; sampled: boolean; retain: boolean; dropped: boolean }

/**
 * Bounded local-only tail retention, no polling or extra requests. Downstream
 * spans and logs receive the same final weight after the local tree ends.
 * Remote inherited traces bypass this buffer: a local error cannot recover
 * the upstream operations which an unknown/unsampled remote parent discarded.
 */
export class DaemonRetainingSpanProcessor implements SpanProcessor {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly downstream: SpanProcessor[], private readonly maxTraces = 256, private readonly maxSpans = 512) {}
  onStart(span: Span, parent: Context): void {
    for (const processor of this.downstream) processor.onStart(span, parent)
    if (span.attributes['mikka.trace.retention'] !== 'head') return
    const { traceId, spanId, traceFlags } = span.spanContext()
    let pending = this.pending.get(traceId)
    if (!pending) {
      if (this.pending.size >= this.maxTraces) this.pending.delete(this.pending.keys().next().value!)
      this.pending.set(traceId, pending = { root: spanId, open: new Set(), spans: [], sampled: Boolean(traceFlags & TraceFlags.SAMPLED), retain: false, dropped: false })
    }
    if (pending.dropped) return
    if (pending.spans.length + pending.open.size >= this.maxSpans) {
      pending.dropped = true; pending.open.clear(); pending.spans = []
    } else pending.open.add(spanId)
  }
  onEnd(span: ReadableSpan): void {
    if (span.attributes['mikka.trace.retention'] !== 'head') { this.emit(span); return }
    const info = span.spanContext(), pending = this.pending.get(info.traceId)
    if (!pending) return
    if (pending.dropped) { if (pending.root === info.spanId) this.pending.delete(info.traceId); return }
    pending.open.delete(info.spanId)
    pending.spans.push(span)
    const ms = span.duration[0] * 1_000 + span.duration[1] / 1_000_000
    if (span.status.code === SpanStatusCode.ERROR || Number(span.attributes['http.response.status_code'] ?? 0) >= 400 || ms >= SLOW_OPERATION_MS) pending.retain = true
    if (pending.open.size) return
    this.pending.delete(info.traceId)
    if (pending.retain) for (const item of pending.spans) this.emit(Object.create(item, {
      spanContext: { value: () => ({ ...item.spanContext(), traceFlags: item.spanContext().traceFlags | TraceFlags.SAMPLED }) },
      attributes: { value: { ...item.attributes, 'mikka.trace.retention': 'error_or_slow', 'mikka.trace.sample_rate': 1 } },
    }) as ReadableSpan)
    else if (pending.sampled) for (const item of pending.spans) this.emit(item)
  }
  private emit(span: ReadableSpan) { for (const processor of this.downstream) processor.onEnd(span) }
  async forceFlush(): Promise<void> { await Promise.all(this.downstream.map(processor => processor.forceFlush())) }
  async shutdown(): Promise<void> { this.pending.clear(); await Promise.all(this.downstream.map(processor => processor.shutdown())) }
}
