import { organizationSession } from '@/lib/enterprise/http'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { restoreOrganizationMember } from '@/lib/governance/organizations'

type Context = { params: Promise<{ organizationId: string; userId: string }> }

export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId, userId } = await context.params
  const session = await organizationSession(request, organizationId)
  return restoreOrganizationMember(organizationId, session.user.id, userId, await governanceJson(request))
}))
