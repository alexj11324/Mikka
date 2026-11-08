import { CodedError } from '@mikka/protocol/coded-error'
import { EGRESS_MAX_REQUEST_BYTES, executeEgressRequest, type EgressHttpRequest } from './egress-http'

const MAX_ENVELOPE = Math.ceil(EGRESS_MAX_REQUEST_BYTES / 3) * 4 + 128 * 1024
const responseHeaders = { 'content-type': 'application/json', 'cache-control': 'private, no-store' }

/** Capability-authenticated data plane: intentionally no database, session,
 * device authorization RPC or control-plane middleware imports. */
export async function taskSecretEgressResponse(request: Request, runId: string,
  execute: typeof executeEgressRequest = executeEgressRequest): Promise<Response> {
  const refuse = (detail: string, status: number) => new Response(JSON.stringify({ code: 'task_secret_unavailable', detail }), { status, headers: responseHeaders })
  if (request.method !== 'POST' || !/^[0-9a-f-]{36}$/i.test(runId) || request.headers.has('origin')
    || request.headers.has('sec-fetch-site') || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return refuse('invalid_request', 400)
  const announced = request.headers.get('content-length')
  if (announced && (!/^\d+$/.test(announced) || Number(announced) > MAX_ENVELOPE)) return refuse('limit_exceeded', 413)
  if (!request.body) return refuse('invalid_request', 400)
  const reader = request.body.getReader()
  let bytes = 0
  const parts: Uint8Array[] = []
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.length
      if (bytes > MAX_ENVELOPE) { await reader.cancel(); return refuse('limit_exceeded', 413) }
      parts.push(part.value)
    }
    const input: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
    if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('invalid_request', 400)
    const result = await execute(input as EgressHttpRequest, { runId }, { signal: request.signal })
    return new Response(JSON.stringify(result), { headers: responseHeaders })
  } catch (error) {
    // An upstream error/cause can contain authentication or response bytes.
    // Only closed protocol codes cross this boundary; never log the envelope.
    if (error instanceof CodedError && error.code === 'task_secret_unavailable') {
      const detail = error.detail ?? 'invalid_request'
      const status = detail === 'expired_capability' ? 410
        : detail === 'invalid_capability' || detail === 'binding_mismatch' ? 401
        : detail === 'limit_exceeded' ? 413
        : detail === 'upstream_unavailable' || detail === 'response_blocked' ? 502 : 403
      return refuse(detail, status)
    }
    return refuse('invalid_request', 400)
  } finally { reader.releaseLock() }
}
