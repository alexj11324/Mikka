import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { safeErrorAttributes } from '@mikka/protocol/tracing'
import { routeScope } from '@/lib/tracing/labels'
import { clientKindFor } from '@/lib/tracing/spans'
import { SERVICE_NAME } from '@/lib/tracing/config'

export type RequestTrace = {
  run<T>(callback: () => T): T
  finish(status: number, error?: unknown): void
}

/** route is the generated route template, never a concrete path or query. */
export function beginRequestTrace(request: Request, route: string): RequestTrace {
  // Accept only the standard trace carrier. Baggage and arbitrary incoming
  // headers must not become attributes or propagate into business work.
  const carrier = {
    traceparent: request.headers.get('traceparent') ?? undefined,
    tracestate: request.headers.get('tracestate') ?? undefined,
  }
  const parent = propagation.extract(ROOT_CONTEXT, carrier)
  const span = trace.getTracer(SERVICE_NAME).startSpan(`${request.method} ${route}`, {
    kind: SpanKind.SERVER,
    attributes: {
      'http.request.method': request.method,
      'http.route': route,
      'url.path': route,
      'mikka.route': route,
      'mikka.client_kind': clientKindFor(route),
    },
  }, parent)
  const active = trace.setSpan(parent, span)
  let finished = false
  return {
    run: callback => context.with(active, () => routeScope.run(route, callback)),
    // H3's actual response-disposal boundary calls this before running after
    // jobs. Ending at handler return would truncate streaming requests; holding
    // the span through after jobs would misattribute their own detached spans.
    finish(status, error) {
      if (finished) return
      finished = true
      span.setAttribute('http.response.status_code', status)
      if (error !== undefined) span.setAttributes(safeErrorAttributes(error))
      if (status >= 500 || error !== undefined) span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
    },
  }
}
