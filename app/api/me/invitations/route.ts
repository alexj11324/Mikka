import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { governanceResponse } from '@/lib/governance/http'
import { listReceivedOrganizationInvitations } from '@/lib/governance/organization-invitations'

export const runtime = 'nodejs'

export const GET = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  return listReceivedOrganizationInvitations(session.user)
}))
