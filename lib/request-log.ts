import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'

// Start and completion JSON lines per API request, written to stdout so Vercel Runtime Logs
// (free on every plan) can search it. Only safe fields: never headers,
// cookies, tokens, bodies, query strings or emails. The user is a sha256 hash.

export type RequestLogOutcome = 'empty' | 'work' | 'ignored'
type Store = { userId?: string; outcome?: RequestLogOutcome }
const requestScope = new AsyncLocalStorage<Store>()

/** Records the signed-in user for the current request's log line. */
export function noteLogUser(userId: string | null | undefined) {
  const store = requestScope.getStore()
  if (store && userId) store.userId = userId
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
    const store: Store = {}
    const requestId = requestIdFor(request), invocationId = randomUUID()
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
        userIdHash: store.userId ? hashUserId(store.userId) : null,
        ...(store.outcome ? { outcome: store.outcome } : {}),
      }
      // Error class name only: messages can echo user input or secrets.
      if (error !== undefined) entry.error = error instanceof Error ? error.name : 'unknown'
      try { sink(JSON.stringify(entry), entry.level) } catch { /* logging never breaks a request */ }
    }
    try {
      const response = await requestScope.run(store, () => handler(request, ...rest))
      write(response.status)
      return response
    } catch (error) {
      write(500, error)
      throw error
    }
  }
}
