import { verifyVercelOidcToken } from '@vercel/oidc'
import { CredentialError } from './contracts'

/** Verify the exact app project, team, issuer, audience and environment. */
export async function verifyAppOidc(token: string, environment = process.env.VERCEL_ENV) {
  try {
    if ((environment !== 'preview' && environment !== 'production') || token.length > 16_384) throw new Error()
    await verifyVercelOidcToken(token, {
      issuer: 'https://oidc.vercel.com/mikka-dev',
      audience: 'https://vercel.com/mikka-dev',
      subject: `owner:mikka-dev:project:mikka:environment:${environment}`,
      projectId: 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH',
      ownerId: 'team_C7lwxVVvnUicFli6112mvxpv',
      environment, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'],
    })
  } catch { throw new CredentialError('credential_denied', 403) }
}
