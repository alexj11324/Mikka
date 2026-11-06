import { channel } from 'node:diagnostics_channel'
import { safeErrorAttributes } from '@mikka/protocol/tracing'
import { SpanStatusCode, trace, type Attributes, type Context, type Span as ApiSpan } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { PgRequestHookInformation, PgResponseHookInformation } from '@opentelemetry/instrumentation-pg'
import { basePath } from '@/lib/base-path-config.mjs'
import { routeScope, workflowStepRoute } from './labels'
import { statementId, statementOperation } from './sanitize'
import { captureTraceContext, traceAttributes } from './context'

// What each span says about where it came from (docs/operations/tracing.md):
// `mikka.route`, the grouping key, and `mikka.client_kind`, who called.

export type ClientKind = 'web' | 'daemon' | 'mobile' | 'cron' | 'worker' | 'background' | 'workflow'

/**
 * Who calls a route, from its path (with or without the base path) or its
 * job label. The daemon authenticates with a device credential on /v1 and the
 * run tool routes; mobile uses /api/mobile; Vercel cron and the Cloudflare
 * cron workers call /api/cron; webhooks are machine callers; the Workflow
 * SDK delivers steps on /.well-known/workflow. Background jobs
 * (lib/background.ts) are labelled `after:…`, `cron:…` or `workflow:…`.
 */
export function clientKindFor(path: string): ClientKind {
  if (path.startsWith('after:')) return 'background'
  if (path.startsWith('cron:')) return 'cron'
  if (path.startsWith('workflow:')) return 'workflow'
  let route = path.split(/[?#]/, 1)[0]
  if (route === basePath || route.startsWith(`${basePath}/`)) route = route.slice(basePath.length) || '/'
  if (route.startsWith('/v1/') || route.startsWith('/api/runs/mcp/') || route === '/api/runs/github-token') return 'daemon'
  if (route.startsWith('/api/mobile/')) return 'mobile'
  if (route.startsWith('/api/cron/')) return 'cron'
  if (route.startsWith('/.well-known/workflow/')) return 'workflow'
  if (route.startsWith('/api/webhooks/')) return 'worker'
  return 'web'
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/**
 * Stamps every recording span when it starts. The route is a job span's own,
 * else the label in force (`withRequestLog('/api/…')`,
 * `withDatabaseOperation('/actions/…')`, a background job's `after:…` /
 * `cron:…`), else the running Workflow step
 * (`workflow:<workflow>/<step>`), else the parent span, else Next's own
 * `next.route`. The client kind is the job's own, else the parent's, else the
 * step's, else from the incoming path on the root span.
 */
export class RouteAttributesProcessor implements SpanProcessor {
  private readonly requestClientChannel = channel('mikka.request.client')
  private readonly stampRequestClient = (attributes: unknown) => {
    try { trace.getActiveSpan()?.setAttributes(attributes as Attributes) } catch { /* tracing never breaks a request */ }
  }

  private readonly requestErrorChannel = channel('mikka.request.error')
  private readonly stampRequestError = (error: unknown) => {
    try {
      const span = trace.getActiveSpan()
      span?.setAttributes(safeErrorAttributes(error))
      span?.setStatus({ code: SpanStatusCode.ERROR })
    } catch { /* tracing never changes a thrown error */ }
  }

  constructor() {
    this.requestClientChannel.subscribe(this.stampRequestClient)
    this.requestErrorChannel.subscribe(this.stampRequestError)
  }
  onStart(span: Span, parentContext: Context): void {
    try {
      const parent = (trace.getSpan(parentContext) as unknown as { attributes?: Attributes } | undefined)?.attributes
      const own = span.attributes
      const inherited = traceAttributes(captureTraceContext({}, parentContext))
      for (const [key, value] of Object.entries(inherited)) if (own[key] === undefined) span.setAttribute(key, value)
      if (typeof own['workflow.run.id'] === 'string') span.setAttribute('mikka.workflow_run_id', own['workflow.run.id'])
      const step = workflowStepRoute()
      const route = text(own['mikka.route']) ?? routeScope.getStore() ?? step ?? text(parent?.['mikka.route']) ?? text(own['next.route']) ?? text(own['http.route'])
      const path = text(own['http.target']) ?? text(own['url.path'])
      // A child keeps its parent's kind: an outbound fetch's path says nothing about who called.
      const kind = text(own['mikka.client_kind']) ?? text(parent?.['mikka.client_kind']) ?? (step ? 'workflow' : undefined) ?? (path && clientKindFor(path)) ?? (route ? clientKindFor(route) : 'web')
      if (route) span.setAttribute('mikka.route', route)
      span.setAttribute('mikka.client_kind', kind)
      // A background job owns its kind and does not inherit the scheduling phone's version.
      if (kind === 'mobile') {
        const version = text(own['mikka.app.version']) ?? text(parent?.['mikka.app.version'])
        if (version) span.setAttribute('mikka.app.version', version)
      }
    } catch { /* attributes never break a request */ }
  }
  onEnd(_span: ReadableSpan): void {}
  forceFlush(): Promise<void> { return Promise.resolve() }
  shutdown(): Promise<void> {
    this.requestClientChannel.unsubscribe(this.stampRequestClient)
    this.requestErrorChannel.unsubscribe(this.stampRequestError)
    return Promise.resolve()
  }
}

/** Sizes larger results from their first rows, so a big read costs no more than a small one. */
const SIZE_SAMPLE_ROWS = 50

export function approximateBytes(rows: unknown[] | undefined): number {
  if (!rows?.length) return 0
  const sample = rows.length > SIZE_SAMPLE_ROWS ? rows.slice(0, SIZE_SAMPLE_ROWS) : rows
  return Math.round(Buffer.byteLength(JSON.stringify(sample)) * rows.length / sample.length)
}

/** Before the query runs: the statement's operation and hash. Never its values. */
export function pgRequestHook(span: ApiSpan, { query }: PgRequestHookInformation): void {
  if (!span.isRecording() || typeof query.text !== 'string') return
  span.setAttribute('db.operation', statementOperation(query.text))
  span.setAttribute('mikka.db.statement_id', statementId(query.text))
}

/** After it answers: row count and an approximate JSON size. Never row content. */
export function pgResponseHook(span: ApiSpan, { data }: PgResponseHookInformation): void {
  if (!span.isRecording()) return
  try {
    // A multi-statement text query answers with one result per statement.
    const results = (Array.isArray(data) ? data : [data]) as PgResponseHookInformation['data'][]
    let count = 0, bytes = 0
    for (const result of results) {
      const rows = Array.isArray(result?.rows) ? result.rows : undefined
      count += typeof result?.rowCount === 'number' ? result.rowCount : rows?.length ?? 0
      bytes += approximateBytes(rows)
    }
    span.setAttribute('db.response.returned_rows', count)
    // The server's command tag beats the first keyword (WITH … INSERT reports INSERT).
    const command = results.at(-1)?.command
    if (command) span.setAttribute('db.operation', command)
    span.setAttribute('mikka.db.response_bytes_approx', bytes)
  } catch { /* sizing never breaks a query */ }
}
