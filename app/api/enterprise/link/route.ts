import { z } from 'zod'
import { auth } from '@/lib/auth'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { GovernanceError } from '@/lib/governance/errors'
import { startIdentityLink } from '@/lib/enterprise/management'

export const runtime = 'nodejs'
export const POST = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const url = new URL(request.url)
  if (request.headers.get('origin') !== url.origin) throw new GovernanceError('access_denied')
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session) throw new GovernanceError('access_denied')
  const { providerId } = z.object({ providerId: z.string().min(1).max(120) }).strict().parse(await governanceJson(request))
  const ticket = await startIdentityLink(session, providerId)
  return Response.json({ providerId, next: 'sign-in/sso' }, { headers: { 'cache-control': 'no-store',
    'set-cookie': `mikka-sso-link=${ticket}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=600` } })
}))
