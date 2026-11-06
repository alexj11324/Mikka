import { SpanKind, SpanStatusCode, TraceFlags, trace, type Attributes, type Context, type Link } from '@opentelemetry/api'
import { SamplingDecision, TraceIdRatioBasedSampler, type ReadableSpan, type Sampler, type SamplingResult, type Span, type SpanProcessor } from '@opentelemetry/sdk-trace-base'

/** Ordinary requests above this duration are retained with their local children. */
export const SLOW_REQUEST_MS = 1_000

export function criticalRoute(method: string, route: string): boolean {
  return route.includes('/.well-known/workflow/') || route.startsWith('/v1/')
    || route.includes('/api/runs/') || route.includes('/api/coordinator/')
    || (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS')
}

/** Head-retain runs; record ordinary requests until their latency/outcome is known. */
export class RunSampler implements Sampler {
  private readonly ratio: TraceIdRatioBasedSampler
  constructor(private readonly rate: number) { this.ratio = new TraceIdRatioBasedSampler(rate) }
  shouldSample(parent: Context, id: string, name: string, _kind: SpanKind, attributes: Attributes, _links: Link[]): SamplingResult {
    if (this.rate <= 0) return { decision: SamplingDecision.NOT_RECORD }
    const caller = trace.getSpanContext(parent)
    const parentAttributes = (trace.getSpan(parent) as unknown as { attributes?: Attributes } | undefined)?.attributes
    const critical = attributes['mikka.trace.critical'] === true || /^(?:workflow|step)\./.test(name)
      || parentAttributes?.['mikka.trace.critical'] === true
    const retained = critical
      || (caller && !caller.isRemote && (caller.traceFlags & TraceFlags.SAMPLED) !== 0)
      || this.ratio.shouldSample(parent, id).decision === SamplingDecision.RECORD_AND_SAMPLED
    return { decision: retained ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.RECORD, attributes: { 'mikka.trace.critical': critical, 'mikka.trace.sample_rate': critical ? 1 : this.rate } }
  }
  toString() { return `MikkaRunSampler(${this.rate})` }
}

type Pending = { open: Set<string>; spans: ReadableSpan[]; headSampled: boolean; retention?: 'error_or_slow' | 'critical_child' }

/**
 * Bounded in-process tail retention, with no timer, network or DB work on the
 * request. Ordinary spans, including head-sampled spans, wait until their
 * local tree ends so errors/slow trees get an effective sample rate of one.
 * Ordinary unsampled successes are discarded;
 * errors/slow requests promote their complete local tree into the batcher.
 * Critical traces bypass buffering. Limits protect a collector outage or a
 * never-ending request; the normal SDK queue still bounds retained spans.
 */
export class RetainingSpanProcessor implements SpanProcessor {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly batcher: SpanProcessor, private readonly maxTraces = 256, private readonly maxSpansPerTrace = 512) {}
  onStart(span: Span, parent: Context): void {
    const { traceId, spanId, traceFlags } = span.spanContext()
    if (span.attributes['mikka.trace.critical'] === true) {
      const pending = this.pending.get(traceId)
      if (pending) pending.retention ??= 'critical_child'
      this.batcher.onStart(span, parent)
      return
    }
    let pending = this.pending.get(traceId)
    if (!pending) {
      if (this.pending.size >= this.maxTraces) this.pending.delete(this.pending.keys().next().value!)
      this.pending.set(traceId, pending = { open: new Set(), spans: [], headSampled: Boolean(traceFlags & TraceFlags.SAMPLED) })
    }
    pending.open.add(spanId)
  }
  onEnd(span: ReadableSpan): void {
    const info = span.spanContext()
    if (span.attributes['mikka.trace.critical'] === true) { this.batcher.onEnd(span); return }
    const pending = this.pending.get(info.traceId)
    if (!pending) return
    pending.open.delete(info.spanId)
    if (pending.spans.length < this.maxSpansPerTrace) pending.spans.push(span)
    const ms = span.duration[0] * 1_000 + span.duration[1] / 1_000_000
    const httpStatus = Number(span.attributes['http.response.status_code'] ?? span.attributes['http.status_code'] ?? 0)
    if (span.status.code === SpanStatusCode.ERROR || httpStatus >= 400 || ms >= SLOW_REQUEST_MS) pending.retention = 'error_or_slow'
    if (!pending.open.size) {
      this.pending.delete(info.traceId)
      if (pending.retention) for (const item of pending.spans) this.batcher.onEnd(Object.create(item, {
        spanContext: { value: () => ({ ...item.spanContext(), traceFlags: item.spanContext().traceFlags | TraceFlags.SAMPLED }) },
        attributes: { value: { ...item.attributes, 'mikka.trace.retention': pending.retention, 'mikka.trace.sample_rate': 1 } },
      }) as ReadableSpan)
      else if (pending.headSampled) for (const item of pending.spans) this.batcher.onEnd(item)
    }
  }
  forceFlush(): Promise<void> { return this.batcher.forceFlush() }
  shutdown(): Promise<void> { this.pending.clear(); return this.batcher.shutdown() }
}
