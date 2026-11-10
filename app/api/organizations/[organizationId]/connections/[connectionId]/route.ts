import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { organizationSession } from '@/lib/enterprise/http'
import { revokeOrganizationConnection, saveOrganizationConnection } from '@/lib/organization-connections'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string; connectionId: string }> }
export const PUT = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId, connectionId } = await context.params
  const session = await organizationSession(request, organizationId)
  return saveOrganizationConnection(organizationId, session.user.id, await governanceJson(request), connectionId)
}))
export const DELETE = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId, connectionId } = await context.params
  const session = await organizationSession(request, organizationId)
  return revokeOrganizationConnection(organizationId, session.user.id, connectionId)
}))
