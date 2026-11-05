import { SpanStatusCode, context, isSpanContextValid, trace, type Link, type Span } from '@opentelemetry/api'
import { routeScope } from './labels'
import { safeErrorAttributes } from '@mikka/protocol/tracing'

// Background work as its own labelled job (docs/operations/tracing.md,
// "Background work"). Only @opentelemetry/api: without a registered tracer
// (tests, CI, a sample rate of 0) the spans are no-ops and only the label
// (which the db_sample log line also reads) remains.

export type JobKind = 'background' | 'workflow' | 'cron'
export type JobOptions = {
  /**
   * Start a new trace even when a span is active, linked to it. For deferred
   * work (after()), which inherits the context of the request that scheduled
   * it: that request's span has ended or is about to.
   */
  detach?: boolean
}

const isThenable = (value: unknown): value is PromiseLike<unknown> => typeof (value as { then?: unknown } | null)?.then === 'function'

/** True for an SDK span that has already ended (a non-recording, unsampled parent is still live). */
const ended = (span: Span) => (span as unknown as { ended?: unknown }).ended === true

/**
 * Runs `work` under the job's label: a span named `route` with
 * `mikka.route=route` and `mikka.client_kind=kind`, and the same label in the
 * route scope, so every query inside it (and any db_sample line) carries the
 * job's route rather than the caller's.
 *
 * The span is a child of the active span when that span is still live (a cron
 * handler inside its request). Otherwise, or with `detach`, it is a new root
 * span with a link to the scheduling span, and the sampler decides it at the
 * same MIKKA_TRACE_SAMPLE_RATE as a request. Tracing never changes the work's
 * result or throws into it.
 */
export function runJob<T>(route: string, kind: JobKind, work: () => T, { detach = false }: JobOptions = {}): T {
  let span: Span | undefined
  let scope = context.active()
  try {
    const active = trace.getSpan(scope)
    const nested = !detach && active !== undefined && !ended(active)
    const from = active?.spanContext()
    const links: Link[] | undefined = !nested && from && isSpanContextValid(from) ? [{ context: from }] : undefined
    span = trace.getTracer('mikka.jobs').startSpan(route, { root: !nested, links, attributes: { 'mikka.route': route, 'mikka.client_kind': kind } }, scope)
    scope = trace.setSpan(scope, span)
  } catch { span = undefined }
  const finish = (failed: boolean, error?: unknown) => {
    try {
      if (failed) {
        span?.setAttributes(safeErrorAttributes(error))
        span?.setStatus({ code: SpanStatusCode.ERROR })
      }
      span?.end()
    } catch { /* tracing never breaks the job */ }
  }
  return context.with(scope, () => routeScope.run(route, () => {
    let result: T
    try { result = work() } catch (error) { finish(true, error); throw error }
    if (!isThenable(result)) { finish(false); return result }
    return Promise.resolve(result).then(value => { finish(false); return value }, (error: unknown) => { finish(true, error); throw error }) as T
  }))
}
