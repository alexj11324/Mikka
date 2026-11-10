import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { requestOrganizationResourceApproval, decideOrganizationResourceApproval } from '@/lib/governance/resource-policy'
import { organizationSession } from '@/lib/enterprise/http'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }
export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return requestOrganizationResourceApproval(organizationId, session.user.id, await governanceJson(request))
}))
export const PATCH = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  await decideOrganizationResourceApproval(organizationId, session.user.id, await governanceJson(request))
  return { decided: true }
}))
