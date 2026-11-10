import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { organizationSession } from '@/lib/enterprise/http'
import { readOrganizationConnections, saveOrganizationConnection } from '@/lib/organization-connections'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }
export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return readOrganizationConnections(organizationId, session.user.id)
}))
export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return saveOrganizationConnection(organizationId, session.user.id, await governanceJson(request))
}))
