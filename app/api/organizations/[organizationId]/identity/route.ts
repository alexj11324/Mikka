import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { GovernanceError } from '@/lib/governance/errors'
import { identitySummary, manageIdentity } from '@/lib/enterprise/management'
import { organizationSession, organizationAccountSession } from '@/lib/enterprise/http'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }
export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await organizationSession(request, (await context.params).organizationId)
  return identitySummary((await context.params).organizationId, session.user.id)
}))
export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const origin = new URL(request.url).origin
  if (request.headers.get('origin') !== origin) throw new GovernanceError('access_denied')
  const session = await organizationAccountSession(request)
  return manageIdentity((await context.params).organizationId, session, await governanceJson(request), origin)
}))
