import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSummary, updateOrganizationMember } from '@/lib/governance/organizations'
import { governanceJson, governanceResponse, governanceSession } from '@/lib/governance/http'
export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await governanceSession(request)
  return organizationSummary((await context.params).organizationId, session.user.id)
}))
export const PATCH = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await governanceSession(request)
  await updateOrganizationMember((await context.params).organizationId, session.user.id, await governanceJson(request))
  return { updated: true }
}))
