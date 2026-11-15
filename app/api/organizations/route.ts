import { freshSessionRoute } from '@/lib/fresh-session'
import { createOrganization, listArchivedOrganizations, listOrganizations } from '@/lib/governance/organizations'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { organizationAccountSession } from '@/lib/enterprise/http'
export const runtime = 'nodejs'

export const GET = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  if (new URL(request.url).searchParams.get('archived') === 'true') {
    return { organizations: await listArchivedOrganizations(session.user.id) }
  }
  return { organizations: await listOrganizations(session.user.id) }
}))
export const POST = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  return createOrganization(session.user, await governanceJson(request))
}))
