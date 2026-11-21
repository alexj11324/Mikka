import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { acceptOrganizationInvitation } from '@/lib/governance/organization-invitations'


/** Only explicit, reauthorized team scopes grant member-level workspace access. */
export const POST = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  return acceptOrganizationInvitation(await governanceJson(request), session.user, session.session.id)
}))
