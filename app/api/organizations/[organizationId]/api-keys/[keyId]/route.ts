import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSession } from '@/lib/enterprise/http'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { renameOrganizationApiKey } from '@/lib/governance/organization-api-keys'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string; keyId: string }> }

export const PATCH = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId, keyId } = await context.params
  const session = await organizationSession(request, organizationId)
  return renameOrganizationApiKey(organizationId, session.user, keyId, await governanceJson(request))
}))
