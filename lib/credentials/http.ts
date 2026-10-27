import { CredentialError } from './contracts.js'

export const privateHeaders = { 'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
export function checkCredentialRequest(request: Request) {
  const origin = new URL(request.url).origin
  if (request.headers.get('origin') !== origin || request.headers.get('x-mikka-credential') !== '1' || request.headers.get('sec-fetch-site') === 'cross-site') throw new CredentialError('credential_csrf_rejected', 403)
}
/** Reused from #313: actual stream limit, JSON only, no provider/body errors. */
export async function credentialBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new CredentialError('credential_json_required', 415)
  if (Number(request.headers.get('content-length')) > 12_288) throw new CredentialError('credential_body_too_large', 413)
  const reader = request.body?.getReader()
  if (!reader) throw new CredentialError('credential_body_invalid', 400)
  const chunks: Uint8Array[] = []; let size = 0
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
  } finally { for (const chunk of chunks) chunk.fill(0); reader.releaseLock() }
}
export function credentialFailure(error: unknown) {
  return Response.json({ error: error instanceof CredentialError ? error.code : 'credential_unavailable' }, { status: error instanceof CredentialError ? error.status : 503, headers: privateHeaders })
}
