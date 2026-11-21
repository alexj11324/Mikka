import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { governanceResponse } from '@/lib/governance/http'
import { readPersonalSecurity } from '@/lib/governance/organization-security'

export const GET = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  return readPersonalSecurity(session.user.id, session.session.id)
}))
