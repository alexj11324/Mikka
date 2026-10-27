import type { IncomingMessage, ServerResponse } from 'node:http'
import { Pool } from 'pg'
import { fillCredential } from '../../../lib/credentials/broker.js'
import { verifyAppOidc } from '../../../lib/credentials/oidc.js'
import { credentialBody, credentialFailure, privateHeaders } from '../../../lib/credentials/http.js'
import { CredentialError } from '../../../lib/credentials/contracts.js'

const pool = new Pool({ connectionString: process.env.MIKKA_DATABASE_URL, max: 3, connectionTimeoutMillis: 10_000 })
export default async function handler(request: IncomingMessage, response: ServerResponse) {
  let result: Response
  try {
    if (request.method !== 'POST') throw new CredentialError('credential_denied', 404)
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1]
    if (!token) throw new CredentialError('credential_denied', 403)
    await verifyAppOidc(token)
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 12_288) throw new CredentialError('credential_body_too_large', 413)
      chunks.push(Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks)
    let input: unknown
    try { input = await credentialBody(new Request('https://broker.invalid/api/fill', { method: 'POST', headers: { 'content-type': String(request.headers['content-type'] ?? '') }, body })) }
    finally { body.fill(0); for (const chunk of chunks) chunk.fill(0) }
    if (!input || typeof input !== 'object' || Object.keys(input).join() !== 'lease' || typeof (input as { lease?: unknown }).lease !== 'string') throw new CredentialError('credential_denied', 404)
    result = Response.json(await fillCredential(pool, (input as { lease: string }).lease), { headers: privateHeaders })
  } catch (error) { result = credentialFailure(error) }
  response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text())
}
