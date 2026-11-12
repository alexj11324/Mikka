import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSession } from '@/lib/enterprise/http'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { issueOrganizationInvitations, listOrganizationInvitations, revokeOrganizationInvitation } from '@/lib/governance/organization-invitations'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return listOrganizationInvitations(organizationId, session.user.id)
}))

export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return issueOrganizationInvitations(organizationId, session.user.id, await governanceJson(request))
}))

export const DELETE = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return revokeOrganizationInvitation(organizationId, session.user.id, await governanceJson(request))
}))
