import { AsyncLocalStorage } from 'node:async_hooks'
import { trace, type Attributes, type Context, type Span as ApiSpan } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { PgRequestHookInformation, PgResponseHookInformation } from '@opentelemetry/instrumentation-pg'
import { basePath } from '@/lib/base-path-config.mjs'
import { statementId, statementOperation } from './sanitize'

// What each span says about where it came from (docs/operations/tracing.md):
// `mikka.route`, the grouping key, and `mikka.client_kind`, who called.

export type ClientKind = 'web' | 'daemon' | 'mobile' | 'cron' | 'worker'

/**
 * Who calls a route, from its path (with or without the base path). The
 * daemon authenticates with a device credential on /v1 and the run tool
 * routes; mobile uses /api/mobile; Vercel cron and the Cloudflare cron
 * workers call /api/cron; webhooks and Workflow steps are machine callers.
 */
export function clientKindFor(path: string): ClientKind {
  let route = path.split(/[?#]/, 1)[0]
  if (route === basePath || route.startsWith(`${basePath}/`)) route = route.slice(basePath.length) || '/'
  if (route.startsWith('/v1/') || route.startsWith('/api/runs/mcp/') || route === '/api/runs/github-token') return 'daemon'
  if (route.startsWith('/api/mobile/')) return 'mobile'
  if (route.startsWith('/api/cron/')) return 'cron'
  if (route.startsWith('/api/webhooks/') || route.startsWith('/.well-known/workflow/')) return 'worker'
  return 'web'
}

/** The route template or Server Action name lib/request-log.ts and withDatabaseOperation run under. */
const routeScope: AsyncLocalStorage<string> = ((globalThis as Record<symbol, unknown>)[Symbol.for('mikka.requestRoute')] ??= new AsyncLocalStorage<string>()) as AsyncLocalStorage<string>

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/**
 * Stamps every recording span when it starts. The route comes from the
 * request's label (`withRequestLog('/api/…')`, `withDatabaseOperation('/actions/…')`),
 * else from the parent span, else from Next's own `next.route`. The client
 * kind comes from the incoming path on the root span and is inherited below it.
 */
export class RouteAttributesProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    try {
      const parent = (trace.getSpan(parentContext) as unknown as { attributes?: Attributes } | undefined)?.attributes
      const own = span.attributes
      const route = routeScope.getStore() ?? text(parent?.['mikka.route']) ?? text(own['next.route']) ?? text(own['http.route'])
      const path = text(own['http.target']) ?? text(own['url.path'])
      const kind = (path && clientKindFor(path)) ?? text(parent?.['mikka.client_kind']) ?? (route ? clientKindFor(route) : 'web')
      if (route) span.setAttribute('mikka.route', route)
      span.setAttribute('mikka.client_kind', kind)
    } catch { /* attributes never break a request */ }
  }
  onEnd(_span: ReadableSpan): void {}
  forceFlush(): Promise<void> { return Promise.resolve() }
  shutdown(): Promise<void> { return Promise.resolve() }
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
