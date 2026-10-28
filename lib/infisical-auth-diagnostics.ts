import { createHash } from 'node:crypto'

export type UniversalAuthRejection = {
  reason: 'invalid_credentials' | 'client_secret_expired' | 'client_secret_usage_limit' | 'temporarily_locked' | 'ip_denied' | 'unknown'
  /** Correlation digest only; the untrusted upstream identifier is never logged. */
  requestIdHash?: string
}
const MAX_BYTES = 4096
const MAX_CHUNKS = 64
const BODY_TIMEOUT_MS = 250
const messages = new Map<string, UniversalAuthRejection['reason']>([
  ['Invalid credentials', 'invalid_credentials'],
  ['Access denied due to expired client secret', 'client_secret_expired'],
  ['Access denied due to client secret usage limit reached', 'client_secret_usage_limit'],
  ['This identity auth method is temporarily locked, please try again later', 'temporarily_locked'],
])

/** Bounded diagnostics, not an authorization decision. Never return upstream text. */
export async function classifyUniversalAuthRejection(response: Response, sensitiveValues: readonly string[]): Promise<UniversalAuthRejection> {
  const unknown: UniversalAuthRejection = { reason: 'unknown' }
  const reader = response.body?.getReader()
  if (!reader) return unknown
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return unknown
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) return unknown
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic_timeout')), BODY_TIMEOUT_MS) })
    const chunks: Uint8Array[] = []
    let length = 0, complete = false
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const chunk = await Promise.race([reader.read(), timeout])
      if (chunk.done) { complete = true; break }
      length += chunk.value.byteLength
      if (length > MAX_BYTES) return unknown
      chunks.push(chunk.value)
    }
    if (!complete) return unknown
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return unknown
    const body = data as Record<string, unknown>
    if (body.statusCode !== response.status) return unknown
    let reason: UniversalAuthRejection['reason'] = 'unknown'
    if (response.status === 401 && body.error === 'UnauthorizedError' && typeof body.message === 'string') {
      reason = messages.get(body.message) ?? 'unknown'
    } else if (response.status === 403 && body.error === 'ForbiddenRequestError' && body.message === 'You are not allowed to access this resource from the current IP address') {
      reason = 'ip_denied'
    }
    const id = body.reqId
    // Fastify generated ID or UUID only. Hash even valid IDs: upstream data may be malicious.
    const validId = typeof id === 'string' && id.length <= 40 &&
      (/^req-[a-z0-9]{1,12}$/.test(id) || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) &&
      !sensitiveValues.some(value => value && id === value)
    return validId ? { reason, requestIdHash: createHash('sha256').update(id).digest('hex') } : { reason }
  } catch {
    return unknown
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // A hostile stream must not delay the failure or escape as an unhandled rejection.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
