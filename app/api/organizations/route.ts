import { freshSessionRoute } from '@/lib/fresh-session'
import { createOrganization, listOrganizations } from '@/lib/governance/organizations'
import { governanceJson, governanceResponse, governanceSession } from '@/lib/governance/http'
export const runtime = 'nodejs'

export const GET = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const session = await governanceSession(request)
  return { organizations: await listOrganizations(session.user.id) }
}))
export const POST = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const session = await governanceSession(request)
  return createOrganization(session.user, await governanceJson(request))
}))
