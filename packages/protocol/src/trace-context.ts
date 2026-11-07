/** W3C trace context for Mikka requests. IDs correlate operations; they never authenticate a caller. */
export function validTraceparent(value: unknown): value is string {
  return typeof value === 'string' && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value)
    && value.slice(3, 35) !== '0'.repeat(32) && value.slice(36, 52) !== '0'.repeat(16)
}

/** Telemetry references only. This carrier never grants access to a run or account. */
export type RunTraceContext = {
  traceparent: string
  runId?: string
  threadId?: string
  taskId?: string
  taskNumber?: string
  workflowRunId?: string
  posthogDistinctId?: string
  sessionId?: string
  /** Actual upstream rate in a durable payload; never accepted from HTTP headers. */
  sampleRate?: number
}

export const TRACE_FIELDS = {
  runId: 'mikka.run_id', threadId: 'mikka.thread_id', taskId: 'mikka.task_id',
  taskNumber: 'mikka.task_number', workflowRunId: 'mikka.workflow_run_id',
  posthogDistinctId: 'posthogDistinctId', sessionId: 'sessionId',
} as const

/** Bounded opaque IDs only: never arbitrary text, email addresses, paths or credentials. */
export function telemetryId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
    && !/^(?:ph[cx]_\w|sk[-_]|gh[pousr]_|github_pat_)/i.test(value)
}

export function sanitizeTraceContext(value: unknown): RunTraceContext | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  if (!validTraceparent(input.traceparent)) return undefined
  const result: RunTraceContext = { traceparent: input.traceparent }
  for (const key of Object.keys(TRACE_FIELDS) as (keyof typeof TRACE_FIELDS)[]) {
    const field = input[key]
    if (telemetryId(field)) result[key] = field
  }
  if (typeof input.sampleRate === 'number' && Number.isFinite(input.sampleRate) && input.sampleRate > 0 && input.sampleRate <= 1) result.sampleRate = input.sampleRate
  return result
}

export function traceAttributes(value: RunTraceContext | undefined): Record<string, string | number> {
  const clean = sanitizeTraceContext(value)
  const attributes: Record<string, string | number> = {}
  if (clean) for (const [key, attribute] of Object.entries(TRACE_FIELDS)) {
    const field = clean[key as keyof typeof TRACE_FIELDS]
    if (field) attributes[attribute] = field
  }
  if (clean?.sampleRate !== undefined) attributes['mikka.trace.sample_rate'] = clean.sampleRate
  return attributes
}

/** App-to-app carrier; use only for Mikka endpoints and durable queue payloads. */
export function runTraceHeaders(value: RunTraceContext | undefined): Record<string, string> {
  const clean = sanitizeTraceContext(value)
  if (!clean) return {}
  const headers: Record<string, string> = { traceparent: clean.traceparent }
  for (const key of Object.keys(TRACE_FIELDS) as (keyof typeof TRACE_FIELDS)[]) {
    const field = clean[key]
    if (field) headers[`x-mikka-trace-${key.toLowerCase()}`] = field
  }
  return headers
}

export function traceContextFromHeaders(get: (key: string) => unknown): RunTraceContext | undefined {
  const values: Record<string, unknown> = { traceparent: get('traceparent') }
  for (const key of Object.keys(TRACE_FIELDS)) values[key] = get(`x-mikka-trace-${key.toLowerCase()}`)
  return sanitizeTraceContext(values)
}

/** No client span is exported. The server independently applies its configured sampling rate. */
export function newTraceparent(random: () => number = Math.random): string {
  const hex = (words: number) => {
    let id = ''
    for (let index = 0; index < words; index++) id += Math.floor(random() * 0x100000000).toString(16).padStart(8, '0')
    return /^0+$/.test(id) ? `${id.slice(1)}1` : id
  }
  return `00-${hex(4)}-${hex(2)}-00`
}

/** Keep version labels bounded and numeric; arbitrary header strings must never become span attributes. */
export function appVersion(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value) ? value : undefined
}

export function mobileTraceHeaders(version: unknown, parent?: string | null): Record<string, string> {
  const safeVersion = appVersion(version)
  return {
    traceparent: validTraceparent(parent) ? parent : newTraceparent(),
    'x-mikka-client-kind': 'mobile',
    ...(safeVersion ? { 'x-mikka-app-version': safeVersion } : {}),
  }
}

/** A fetch wrapper confined to the configured Mikka API origin and base path. Adds no baggage or user identifiers. */
export function mobileTraceFetch(base: string, version: unknown, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  const target = new URL(base)
  const apiPrefix = `${target.pathname.replace(/\/$/, '')}/api/`
  return (input, init) => {
    const raw = input instanceof Request ? input.url : String(input)
    let url: URL
    try { url = new URL(raw, base) } catch { return fetchImpl(input, init) }
    if (url.origin !== target.origin || !url.pathname.startsWith(apiPrefix)) return fetchImpl(input, init)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    try {
      for (const [key, value] of Object.entries(mobileTraceHeaders(version, headers.get('traceparent')))) headers.set(key, value)
    } catch { /* Trace generation must not prevent login or an API request. */ }
    return fetchImpl(input, { ...init, headers })
  }
}
