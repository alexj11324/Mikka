import type { IncomingMessage, ServerResponse } from 'node:http'
import { verifyAppOidc } from '../../../lib/credentials/oidc'
import { assumeVercelRole } from '../../../lib/credentials/kms'
import { credentialFailure, privateHeaders } from '../../../lib/credentials/http'
import { CredentialError } from '../../../lib/credentials/contracts'

/** Protected Preview-only identity acceptance. Never returns JWTs or STS keys. */
export default async function handler(request: IncomingMessage, response: ServerResponse) {
  let result: Response
  try {
    if (process.env.VERCEL_ENV !== 'preview' || request.method !== 'POST') throw new CredentialError('credential_denied', 404)
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1]
    if (!token) throw new CredentialError('credential_denied', 403)
    await verifyAppOidc(token)
    const broker = await assumeVercelRole('broker').then(() => true, () => false)
    const app = await assumeVercelRole('app').then(() => true, () => false)
    result = Response.json({ project: 'mikka-credential-broker', ownRole: broker, crossRole: app }, { headers: privateHeaders })
  } catch (error) { result = credentialFailure(error) }
  response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text())
}
