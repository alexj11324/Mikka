import type { IncomingMessage, ServerResponse } from 'node:http'
import { verifyAppOidc } from '../../../lib/credentials/oidc.js'
import { assumeVercelRole, awsKms, open } from '../../../lib/credentials/kms.js'
import { z } from 'zod'
import { credentialFailure, privateHeaders } from '../../../lib/credentials/http.js'
import { CredentialError } from '../../../lib/credentials/contracts.js'

/** Protected Preview-only identity acceptance. Never returns JWTs or STS keys. */
export default async function handler(request: IncomingMessage, response: ServerResponse) {
  let result: Response
  try {
    if (process.env.VERCEL_ENV !== 'preview' || request.method !== 'POST') throw new CredentialError('credential_denied', 404)
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1]
    if (!token) throw new CredentialError('credential_denied', 403)
    await verifyAppOidc(token)
    let body = '', bytes = 0
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 8192) throw new CredentialError(); body += chunk.toString() }
    const input = z.object({
      context: z.object({ userId: z.literal('preview-kms-probe'), credentialId: z.uuid(), origin: z.literal('https://example.com') }).strict(),
      envelope: z.object({ v: z.literal(1), wrappedDek: z.string().max(4096), nonce: z.string().max(64), ciphertext: z.string().max(1024) }).strict(),
    }).strict().parse(JSON.parse(body))
    const broker = await assumeVercelRole('broker').then(() => true, () => false)
    const app = await assumeVercelRole('app').then(() => true, () => false)
    const plaintext = await open(awsKms('broker'), input.context, input.envelope)
    const sameContext = plaintext.toString() === 'mikka-preview-kms-probe'; plaintext.fill(0)
    const wrongOwnerRejected = await open(awsKms('broker'), { ...input.context, userId: 'different-preview-owner' }, input.envelope).then(value => { value.fill(0); return false }, () => true)
    result = Response.json({ project: 'mikka-credential-broker', ownRole: broker, crossRole: app, sameContext, wrongOwnerRejected }, { headers: privateHeaders })
  } catch (error) { result = credentialFailure(error) }
  response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text())
}
