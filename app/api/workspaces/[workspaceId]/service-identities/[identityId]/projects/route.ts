import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession, governanceResponse, governanceSession } from '@/lib/governance/http'
import { serviceProjectAccess } from '@/lib/governance/service-project-access'

export const runtime = 'nodejs'
type Context = { params: Promise<{ workspaceId: string; identityId: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId, identityId } = await context.params
  const session = await governanceSession(request, workspaceId)
  return serviceProjectAccess(workspaceId, session.user, identityId)
}))

export const PUT = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId, identityId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return serviceProjectAccess(workspaceId, session.user, identityId, await governanceJson(request))
}))
