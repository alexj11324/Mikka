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
