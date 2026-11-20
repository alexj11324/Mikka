import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSession } from '@/lib/enterprise/http'
import { governanceResponse } from '@/lib/governance/http'
import { verifyAllowedDomain } from '@/lib/governance/organization-join-domains'

type Context = { params: Promise<{ organizationId: string; domainId: string }> }

export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId, domainId } = await context.params
  const session = await organizationSession(request, organizationId)
  return verifyAllowedDomain(organizationId, domainId, session.user.id)
}))
