import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { governanceResponse } from '@/lib/governance/http'
import { joinOrganizationByDomain } from '@/lib/governance/organization-join-domains'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }

export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationAccountSession(request)
  return joinOrganizationByDomain(z.uuid().parse(organizationId), session.user, session.session.id)
}))
