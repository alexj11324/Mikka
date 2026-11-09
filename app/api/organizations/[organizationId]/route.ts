import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSummary, renameOrganization, archiveOrganization } from '@/lib/governance/organizations'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { organizationSession } from '@/lib/enterprise/http'
export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return organizationSummary(organizationId, session.user.id)
}))
export const PATCH = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return renameOrganization(organizationId, session.user.id, await governanceJson(request))
}))
export const DELETE = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId, true)
  return archiveOrganization(organizationId, session.user.id)
}))
