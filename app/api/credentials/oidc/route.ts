import { getVercelOidcToken } from '@vercel/oidc'
import { CredentialError } from '@/lib/credentials/contracts'
import { assumeVercelRole } from '@/lib/credentials/kms'
import { checkCredentialRequest, credentialFailure, privateHeaders } from '@/lib/credentials/http'

export const maxDuration = 60
/** Vercel deployment protection controls access to this Preview-only probe.
 * It returns four authorization booleans, no credentials or account data. */
export async function POST(request: Request) {
  try {
    if (process.env.VERCEL_ENV !== 'preview') throw new CredentialError('credential_denied', 404)
    checkCredentialRequest(request)
    const ownRole = await assumeVercelRole('app').then(() => true, () => false)
    const crossRole = await assumeVercelRole('broker').then(() => true, () => false)
    const brokerUrl = new URL(process.env.CREDENTIAL_BROKER_URL ?? '')
    if (brokerUrl.protocol !== 'https:' || !brokerUrl.hostname.endsWith('.vercel.app')) throw new CredentialError()
    const response = await fetch(new URL('/api/oidc', brokerUrl), { method: 'POST', headers: {
      Authorization: `Bearer ${await getVercelOidcToken()}`,
      ...(process.env.CREDENTIAL_BROKER_PREVIEW_BYPASS ? { 'x-vercel-protection-bypass': process.env.CREDENTIAL_BROKER_PREVIEW_BYPASS } : {}),
    }, redirect: 'error', signal: AbortSignal.timeout(30_000), cache: 'no-store' })
    if (!response.ok) throw new CredentialError()
    const broker = await response.json()
    if (typeof broker.ownRole !== 'boolean' || typeof broker.crossRole !== 'boolean') throw new CredentialError()
    return Response.json({ app: { ownRole, crossRole }, broker: { ownRole: broker.ownRole, crossRole: broker.crossRole } }, { headers: privateHeaders })
  } catch (error) { return credentialFailure(error) }
}
