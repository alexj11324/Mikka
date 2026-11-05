/** W3C trace context for Mikka requests. IDs correlate operations; they never authenticate a caller. */
export function validTraceparent(value: unknown): value is string {
  return typeof value === 'string' && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value)
    && value.slice(3, 35) !== '0'.repeat(32) && value.slice(36, 52) !== '0'.repeat(16)
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
