import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { configureOrganizationResourcePolicy, readOrganizationResourcePolicy } from '@/lib/governance/resource-policy'
import { organizationSession } from '@/lib/enterprise/http'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }
export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return readOrganizationResourcePolicy(organizationId, session.user.id)
}))
export const PATCH = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return configureOrganizationResourcePolicy(organizationId, session.user.id, await governanceJson(request))
}))
