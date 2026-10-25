export class QuotaError extends Error {
  constructor(readonly code: string, readonly status = 429, readonly retryAfter = 1) {
    super(code)
    this.name = 'QuotaError'
  }
}

export function quotaResponse(error: unknown): Response {
  if (!(error instanceof QuotaError)) throw error
  return Response.json({ error: error.code, unit: 'admission_unit' }, {
    status: error.status,
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(error.retryAfter))), 'Cache-Control': 'private, no-store' },
  })
}

/** RFC Retry-After seconds or HTTP date. Invalid/absent values back off for 60s. */
export function retryAfterSeconds(value: string | null | undefined, now = Date.now()): number {
  if (value && /^\d+(\.\d+)?$/.test(value.trim())) return Math.max(1, Math.ceil(Number(value)))
  const date = value ? Date.parse(value) : NaN
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - now) / 1000)) : 60
}

export function quotaFailure(error: unknown): { outcome: 'refunded' | 'uncertain'; retryAfter?: number } {
  // AI errors carry statusCode/responseHeaders; Composio wraps its HTTP API
  // error in cause with status/Headers. Inspect only a bounded cause chain,
  // stopping at the first explicit HTTP status. Unknown/partial work stays held.
  let current = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const e = current as { statusCode?: number; status?: number; responseHeaders?: Record<string,string>; headers?: Headers; cause?: unknown }
    const status = e.statusCode ?? e.status
    if (typeof status === 'number' && status >= 100 && status <= 599) {
      if ([401, 402, 403, 429].includes(status)) {
        const retryAfter = e.responseHeaders?.['retry-after'] ?? e.headers?.get?.('retry-after')
        return { outcome: 'refunded', ...(status === 429 ? { retryAfter: retryAfterSeconds(retryAfter) } : {}) }
      }
      return { outcome: 'uncertain' }
    }
    current = e.cause
  }
  return { outcome: 'uncertain' }
}
