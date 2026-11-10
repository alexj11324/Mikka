import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { organizationSession } from '@/lib/enterprise/http'
import { configureOrganizationModels } from '@/lib/organization-connections'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }
export const PATCH = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return configureOrganizationModels(organizationId, session.user.id, await governanceJson(request))
}))
