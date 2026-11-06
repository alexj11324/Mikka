import { context, createContextKey, isSpanContextValid, propagation, SpanStatusCode, trace, type Attributes, type Context, type TextMapGetter, type TextMapPropagator, type TextMapSetter } from '@opentelemetry/api'
import { TRACE_FIELDS, runTraceHeaders, sanitizeTraceContext, telemetryId, traceAttributes, traceContextFromHeaders, type RunTraceContext } from '@mikka/protocol/trace-context'
import { safeErrorAttributes } from '@mikka/protocol/tracing'

export { traceAttributes }
export type { RunTraceContext }
const key = createContextKey('mikka.run.trace')

export function traceMetadata(scope: Context = context.active()): Partial<RunTraceContext> {
  const metadata = { ...(scope.getValue(key) as Partial<RunTraceContext> | undefined) }
  const parent = trace.getSpan(scope) as unknown as { attributes?: Attributes } | undefined
  for (const [field, attribute] of Object.entries(TRACE_FIELDS)) {
    const value = parent?.attributes?.[attribute]
    if (telemetryId(value)) metadata[field as keyof RunTraceContext] = value
  }
  const workflowRunId = parent?.attributes?.['workflow.run.id']
  if (telemetryId(workflowRunId)) metadata.workflowRunId = workflowRunId
  return metadata
}

/** Serializes the actual active span, not an earlier caller's span id. No network or database work. */
export function captureTraceContext(extra: Partial<RunTraceContext> = {}, scope = context.active()): RunTraceContext | undefined {
  const span = trace.getSpanContext(scope)
  if (!span || !isSpanContextValid(span)) return undefined
  return sanitizeTraceContext({ ...traceMetadata(scope), ...extra, traceparent: `00-${span.traceId}-${span.spanId}-${span.traceFlags.toString(16).padStart(2, '0')}` })
}

export function withTraceContext<T>(carrier: RunTraceContext | undefined, work: () => T): T {
  const clean = sanitizeTraceContext(carrier)
  if (!clean) return work()
  const parent = propagation.extract(context.active(), { traceparent: clean.traceparent })
  return context.with(parent.setValue(key, clean), work)
}

/** Also used by the Workflow SDK's built-in traceCarrier serialization. No arbitrary baggage. */
export class RunContextPropagator implements TextMapPropagator {
  inject<C>(scope: Context, carrier: C, setter: TextMapSetter<C>): void {
    for (const [name, value] of Object.entries(runTraceHeaders(captureTraceContext({}, scope)))) {
      if (name !== 'traceparent') setter.set(carrier, name, value)
    }
  }
  extract<C>(scope: Context, carrier: C, getter: TextMapGetter<C>): Context {
    const clean = traceContextFromHeaders(name => { const value = getter.get(carrier, name); return Array.isArray(value) ? value[0] : value })
    return clean ? scope.setValue(key, clean) : scope
  }
  fields(): string[] { return Object.keys(TRACE_FIELDS).map(name => `x-mikka-trace-${name.toLowerCase()}`) }
}

export function withTraceMetadata<T>(metadata: Partial<RunTraceContext>, work: () => T): T {
  const merged = { ...traceMetadata(), ...metadata }
  const attrs = captureTraceContext(merged)
  trace.getActiveSpan()?.setAttributes(traceAttributes(attrs))
  return context.with(context.active().setValue(key, merged), work)
}

/** Low-cardinality critical operation, always retained when tracing is enabled. */
export function withRunSpan<T>(name: string, attributes: Attributes, work: () => T, carrier?: RunTraceContext): T {
  return withTraceContext(carrier, () => {
    const span = trace.getTracer('mikka.run').startSpan(name, { attributes: { ...traceAttributes(captureTraceContext()), ...attributes, 'mikka.trace.critical': true } })
    const finish = (error?: unknown) => {
      if (error !== undefined) { span.setAttributes(safeErrorAttributes(error)); span.setStatus({ code: SpanStatusCode.ERROR }) }
      span.end()
    }
    return context.with(trace.setSpan(context.active(), span), () => {
      try {
        const value = work()
        if (value && typeof (value as unknown as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(value).then(result => { finish(); return result }, (error: unknown) => { finish(error); throw error }) as T
        }
        finish()
        return value
      } catch (error) { finish(error); throw error }
    })
  })
}
