import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSession } from '@/lib/enterprise/http'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { issueOrganizationInvitations, listOrganizationInvitations, revokeOrganizationInvitation } from '@/lib/governance/organization-invitations'
import { organizationInvitationMailEnabled, sendOrganizationInvitationEmails } from '@/lib/governance/organization-invitation-mail'
import { appOrigin } from '@/lib/mcp/resource'
import { afterJob } from '@/lib/background'

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
  // Persist the invitation and audit record before any external mail side effect.
  const result = await issueOrganizationInvitations(organizationId, session.user.id, await governanceJson(request))
  const trustedOrigin = appOrigin
  if (trustedOrigin && organizationInvitationMailEnabled() && result.outcomes.some(outcome => outcome.created)) {
    // A provider failure must not revoke a valid invite or lose the manual one-time link.
    // The configured origin, not a caller-controlled Host header, anchors every bearer URL.
    afterJob('after:organization-invitation-mail', async () => {
      try {
        const delivery = await sendOrganizationInvitationEmails(result.outcomes, trustedOrigin)
        if (delivery.failed) console.error('organization_invitation_mail_delivery_failed', { count: delivery.failed })
      } catch {
        console.error('organization_invitation_mail_delivery_unavailable')
      }
    }, { orRun: true })
  }
  return result
}))

export const DELETE = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return revokeOrganizationInvitation(organizationId, session.user.id, await governanceJson(request))
}))
