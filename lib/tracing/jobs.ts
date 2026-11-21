import { SpanStatusCode, context, isSpanContextValid, trace, type Span } from '@opentelemetry/api'
import { routeScope } from './labels'
import { safeErrorAttributes } from '@mikka/protocol/tracing'

// Background work as its own labelled job (docs/operations/tracing.md,
// "Background work"). Only @opentelemetry/api: without a registered tracer
// (tests, CI, a sample rate of 0) the spans are no-ops and only the label
// (which the db_sample log line also reads) remains.

export type JobKind = 'background' | 'workflow' | 'cron'

const isThenable = (value: unknown): value is PromiseLike<unknown> => typeof (value as { then?: unknown } | null)?.then === 'function'

/**
 * Runs `work` under the job's label: a span named `route` with
 * `mikka.route=route` and `mikka.client_kind=kind`, and the same label in the
 * route scope, so every query inside it (and any db_sample line) carries the
 * job's route rather than the caller's.
 *
 * The span retains its scheduling parent even after that parent ends. A job
 * with no valid context creates a root. Its independent route label keeps
 * database attribution correct without splitting the run into several traces.
 */
export function runJob<T>(route: string, kind: JobKind, work: () => T): T {
  let span: Span | undefined
  let scope = context.active()
  try {
    const active = trace.getSpan(scope)
    const from = active?.spanContext()
    span = trace.getTracer('mikka.jobs').startSpan(route, { root: !from || !isSpanContextValid(from), attributes: { 'mikka.route': route, 'mikka.client_kind': kind, 'mikka.trace.critical': kind === 'workflow' || /coordinator|dispatch|run-|factory|computer/.test(route) } }, scope)
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
