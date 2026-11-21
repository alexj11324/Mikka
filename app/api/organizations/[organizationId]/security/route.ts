import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSession } from '@/lib/enterprise/http'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { configureOrganizationSecurity, readOrganizationSecurity } from '@/lib/governance/organization-security'

type Context = { params: Promise<{ organizationId: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return readOrganizationSecurity(organizationId, session.user.id)
}))

export const PATCH = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return configureOrganizationSecurity(organizationId, session.user.id, session.session.id, await governanceJson(request))
}))
