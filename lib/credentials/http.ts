import { z } from 'zod'
import { CredentialError, createCredentialRequestSchema, submitCredentialSchema, type Principal } from './contracts'
import type { CredentialBroker } from './broker'

const headers = {
  'Cache-Control': 'private, no-store', 'Pragma': 'no-cache',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
}
async function body(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new CredentialError('credential_json_required', 415)
  if (Number(request.headers.get('content-length')) > 12_288) throw new CredentialError('credential_body_too_large', 413)
  const reader = request.body?.getReader()
  if (!reader) throw new CredentialError('credential_body_invalid', 400)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 12_288) { await reader.cancel(); throw new CredentialError('credential_body_too_large', 413) }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    if (error instanceof CredentialError) throw error
    throw new CredentialError('credential_body_invalid', 400)
  } finally { reader.releaseLock() }
}

/** Used verbatim by Next routes and the local HTTP acceptance harness.
 * No middleware/logger receives the parsed body or original exception. */
export function credentialHttp(options: {
  broker: CredentialBroker; origin: string;
  authenticate: (request: Request) => Promise<Principal | null>
}) {
  return async (request: Request, action: 'create' | 'get' | 'submit' | 'cancel' | 'events', id?: string): Promise<Response> => {
    try {
      const principal = await options.authenticate(request)
      if (!principal) throw new CredentialError('credential_auth_required', 401)
      const mutation = ['create', 'submit', 'cancel'].includes(action)
      if (request.method !== (mutation ? 'POST' : 'GET')) throw new CredentialError('credential_method_invalid', 405)
      const origin = request.headers.get('origin')
      if ((origin && origin !== options.origin) || request.headers.get('sec-fetch-site') === 'cross-site' ||
        (mutation && (origin !== options.origin || request.headers.get('x-mikka-credential') !== '1'))) throw new CredentialError('credential_csrf_rejected', 403)
      if (action !== 'create' && !z.uuid().safeParse(id).success) throw new CredentialError('credential_not_found', 404)
      let result
      if (action === 'create') {
        const parsed = createCredentialRequestSchema.safeParse(await body(request))
        if (!parsed.success) throw new CredentialError('credential_request_invalid', 400)
        result = await options.broker.create(principal, parsed.data)
      } else if (action === 'submit') {
        const parsed = submitCredentialSchema.safeParse(await body(request))
        if (!parsed.success) throw new CredentialError('credential_submission_invalid', 400)
        result = await options.broker.submit(principal, id!, parsed.data)
      } else if (action === 'cancel') {
        const parsed = z.object({}).strict().safeParse(await body(request))
        if (!parsed.success) throw new CredentialError('credential_request_invalid', 400)
        result = await options.broker.cancel(principal, id!)
      } else result = await options.broker.get(principal, id!)
      if (action === 'events') {
        // Reconnectable snapshot stream: a revision is authoritative; no chat/run event ingestion.
        return new Response(`retry: 2000\nid: ${result.version}\nevent: credential.state\ndata: ${JSON.stringify(result)}\n\n`, {
          headers: { ...headers, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' },
        })
      }
      return Response.json(result, { status: action === 'create' ? 201 : 200, headers })
    } catch (error) {
      // Never stringify arbitrary exceptions, Zod errors, Request, headers or provider errors.
      return Response.json({ error: error instanceof CredentialError ? error.code : 'credential_unavailable' }, {
        status: error instanceof CredentialError ? error.status : 503, headers,
      })
    }
  }
}
