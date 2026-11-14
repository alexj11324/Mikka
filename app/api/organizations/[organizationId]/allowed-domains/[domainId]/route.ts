import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSession } from '@/lib/enterprise/http'
import { governanceResponse } from '@/lib/governance/http'
import { removeAllowedDomain } from '@/lib/governance/organization-join-domains'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string; domainId: string }> }

export const DELETE = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId, domainId } = await context.params
  const session = await organizationSession(request, organizationId)
  return removeAllowedDomain(organizationId, domainId, session.user.id)
}))
