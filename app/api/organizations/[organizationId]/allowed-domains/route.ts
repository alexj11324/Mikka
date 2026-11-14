import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSession } from '@/lib/enterprise/http'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { addAllowedDomain, listAllowedDomains } from '@/lib/governance/organization-join-domains'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return listAllowedDomains(organizationId, session.user.id)
}))

export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return addAllowedDomain(organizationId, session.user, await governanceJson(request))
}))
