import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import { withNativeSessionCache } from './desktop-rpc/session-cache-context.ts'

// Start and completion JSON lines per API request, written to stdout so Vercel Runtime Logs
// (free on every plan) can search it. Only safe fields: never headers,
// cookies, tokens, bodies, query strings or emails. The user is a sha256 hash.

export type RequestLogOutcome = 'empty' | 'work' | 'ignored'
type RequestMetadata = { requestId: string; userIdHash?: string; rpcAction?: string }
type Store = { userId?: string; outcome?: RequestLogOutcome; metadata: RequestMetadata; sink?: LogSink; route?: string; method?: string; rpcItemCount?: number; invocationId?: string }
const requestScope = new AsyncLocalStorage<Store>()
// Metadata-only readers for in-process diagnostics. Each module copy keeps its
// own ALS reader: replacing one would silently attribute another copy's work.
// Nothing calls these in production; no query, event or I/O is added here.
const diagnosticKey = Symbol.for('mikka.requestDiagnosticReaders')
const diagnosticGlobals = globalThis as Record<symbol, unknown>
const diagnosticReaders = diagnosticGlobals[diagnosticKey] ??= new Set<() => unknown>()
if (diagnosticReaders instanceof Set) diagnosticReaders.add(() => {
  const store = requestScope.getStore()
  return store ? { httpInvocationId: store.metadata.requestId, invocationId: store.invocationId ?? store.metadata.requestId,
    route: store.route, method: store.method, rpcAction: store.metadata.rpcAction ?? null } : undefined
})
const requestClientChannel = channel('mikka.request.client')
const requestErrorChannel = channel('mikka.request.error')
const requestMetadataChannel = channel('mikka.request.metadata')

function publishMetadata(metadata: RequestMetadata) {
  if (requestMetadataChannel.hasSubscribers) {
    try { requestMetadataChannel.publish(metadata) } catch { /* attribution never breaks a request */ }
  }
}

/** Attribution only, never authentication. Ignore headers on machine-only routes. */
export function requestClientAttributes(request: Request, route: string): Record<string, string> {
  if (request.headers.get('x-mikka-client-kind') !== 'mobile' || !route.startsWith('/api/')
    || /^\/api\/(?:cron|webhooks|runs)(?:\/|$)/.test(route)) return {}
  const version = request.headers.get('x-mikka-app-version')
  return { 'mikka.client_kind': 'mobile',
    ...(version && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version) ? { 'mikka.app.version': version } : {}),
  }
}
// The route template of the request being handled, read by the database sample
// and the tracer (lib/tracing/labels.ts) through this global key. Kept local:
// scripts/ops load this file with plain Node, without the @/ alias.
const routeScope: AsyncLocalStorage<string> = ((globalThis as Record<symbol, unknown>)[Symbol.for('mikka.requestRoute')] ??= new AsyncLocalStorage<string>()) as AsyncLocalStorage<string>

/** Records the signed-in user for the current request's log line. */
export function noteLogUser(userId: string | null | undefined) {
  const store = requestScope.getStore()
  if (store && userId && store.userId !== userId) {
    const hash = hashUserId(userId)
    store.userId = userId
    store.metadata.userIdHash = hash
    publishMetadata(store.metadata)
  }
}

/** Call only after the RPC registry's own-property check; never pass arguments. */
export function noteLogRpcAction(action: string) {
  const store = requestScope.getStore()
  if (store && store.metadata.rpcAction !== action && action.length <= 120 && /^[a-z][\w-]*\.[a-z]\w*$/i.test(action)) {
    store.metadata.rpcAction = action
    publishMetadata(store.metadata)
  }
}

/** Marks the authenticated business branch without logging response or request data. */
export function noteLogOutcome(outcome: RequestLogOutcome) {
  const store = requestScope.getStore()
  if (store && (outcome === 'empty' || outcome === 'work' || outcome === 'ignored')) store.outcome = outcome
}

export function hashUserId(userId: string): string {
  const salt = process.env.LOG_HASH_SALT ?? ''
  return createHash('sha256').update(salt + userId).digest('hex').slice(0, 16)
}

/** Vercel's request id when present, otherwise a generated one. */
export function requestIdFor(request: Request): string {
  const id = request.headers.get('x-vercel-id')
  return id && /^[\w:.-]{1,128}$/.test(id) ? id : randomUUID()
}

export type RequestLogEntry = {
  level: 'info' | 'warn' | 'error'
  msg: 'api_request'
  timestamp: string
  invocationId: string
  requestId: string
  route: string
  method: string
  status: number
  durationMs: number
  userIdHash: string | null
  rpcAction?: string
  rpcItemCount?: number
  outcome?: RequestLogOutcome
  error?: string
}

export type LogSink = (line: string, level: RequestLogEntry['level']) => void

const defaultSink: LogSink = (line, level) => {
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

function levelFor(status: number): RequestLogEntry['level'] {
  return status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
}

/** A logical action inside one authenticated HTTP request. Each item owns its
 * metadata object and span; only the physical request ID is shared. This is
 * ordinary sampled work, never a reason to force retention of all reads. */
export async function withRpcActionLog<T>(action: string, work: () => Promise<T>, status?: (value: T) => number): Promise<T> {
  const parent = requestScope.getStore()
  if (!parent?.sink || !['/api/desktop/rpc', '/api/rpc'].includes(parent.route ?? '')
    || action.length > 120 || !/^[a-z][\w-]*\.[a-z]\w*$/i.test(action)) return work()
  parent.rpcItemCount = (parent.rpcItemCount ?? 0) + 1
  const store: Store = { ...parent, outcome: undefined, metadata: { ...parent.metadata, rpcAction: action } }
  const invocationId = randomUUID(), started = performance.now()
  store.invocationId = invocationId
  const span = trace.getTracer('mikka.rpc').startSpan('rpc.action', { attributes: { 'mikka.rpc.action': action } })
  const write = (completed?: number, error?: unknown) => {
    const level = completed === undefined ? 'info' : levelFor(completed)
    try {
      parent.sink!(JSON.stringify({ level, msg: completed === undefined ? 'rpc_action_started' : 'rpc_action',
        timestamp: new Date().toISOString(), invocationId, httpInvocationId: parent.metadata.requestId,
        route: parent.route, method: parent.method, rpcAction: action,
        ...(completed === undefined ? {} : { status: completed, durationMs: Math.round(performance.now() - started),
          userIdHash: store.metadata.userIdHash ?? null,
          ...(error === undefined ? {} : { error: error instanceof Error ? error.name : 'unknown' }) }),
      }), level)
    } catch { /* logging cannot change an action result */ }
  }
  return context.with(trace.setSpan(context.active(), span), () => requestScope.run(store, async () => {
    publishMetadata(store.metadata)
    write()
    try {
      const value = await work()
      let resultStatus = 200
      try { if (status) resultStatus = status(value) } catch { resultStatus = 500 }
      if (!Number.isInteger(resultStatus) || resultStatus < 100 || resultStatus > 599) resultStatus = 500
      span.setAttribute('mikka.rpc.item_status_code', resultStatus)
      if (resultStatus >= 400) span.setStatus({ code: SpanStatusCode.ERROR })
      write(resultStatus)
      return value
    } catch (error) {
      try { requestErrorChannel.publish(error) } catch { /* tracing is best effort */ }
      span.setStatus({ code: SpanStatusCode.ERROR })
      write(500, error)
      throw error
    } finally { span.end() }
  }))
}

/**
 * Wraps a route handler. `route` is the route template (e.g.
 * `/api/teams/[teamId]/members`), never the concrete path, so ids and query
 * strings stay out of logs.
 */
export function withRequestLog<R extends Request, A extends unknown[], T extends Response>(
  route: string,
  handler: (request: R, ...rest: A) => T | Promise<T>,
  sink: LogSink = defaultSink,
): (request: R, ...rest: A) => Promise<T> {
  return async (request, ...rest) => {
    const started = performance.now()
    const requestId = requestIdFor(request), invocationId = randomUUID()
    // This internal UUID is available before authentication SQL. External request
    // headers remain log context and never become the telemetry attribution key.
    const store: Store = { metadata: { requestId: invocationId }, sink, route, method: request.method }
    publishMetadata(store.metadata)
    // A built-in diagnostic channel keeps plain-Node ops scripts independent of the tracing SDK.
    // Its only subscriber stamps the active Next span; requests work identically with tracing off.
    if (requestClientChannel.hasSubscribers) {
      try { requestClientChannel.publish(requestClientAttributes(request, route)) } catch { /* best effort */ }
    }
    // A missing completion remains observable when a handler/process is killed.
    try { sink(JSON.stringify({ level: 'info', msg: 'api_request_started', timestamp: new Date().toISOString(),
      requestId, invocationId, route, method: request.method }), 'info') } catch { /* best effort */ }
    const write = (status: number, error?: unknown) => {
      const entry: RequestLogEntry = {
        level: levelFor(status),
        msg: 'api_request',
        timestamp: new Date().toISOString(),
        requestId, invocationId,
        route,
        method: request.method,
        status,
        durationMs: Math.round(performance.now() - started),
        userIdHash: store.metadata.userIdHash ?? null,
        ...(store.metadata.rpcAction ? { rpcAction: store.metadata.rpcAction } : {}),
        ...(store.rpcItemCount === undefined ? {} : { rpcItemCount: store.rpcItemCount }),
        ...(store.outcome ? { outcome: store.outcome } : {}),
      }
      // Error class name only: messages can echo user input or secrets.
      if (error !== undefined) entry.error = error instanceof Error ? error.name : 'unknown'
      try { sink(JSON.stringify(entry), entry.level) } catch { /* logging never breaks a request */ }
    }
    try {
      const response = await withNativeSessionCache(request.headers, () => requestScope.run(store, () => routeScope.run(route, () => handler(request, ...rest))))
      write(response.status)
      return response
    } catch (error) {
      try { requestErrorChannel.publish(error) } catch { /* tracing is best effort */ }
      write(500, error)
      throw error
    }
  }
}
