import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession, governanceResponse, governanceSession } from '@/lib/governance/http'
import { createServiceIdentity, listServiceIdentities } from '@/lib/governance/service-identities'

export const runtime = 'nodejs'
type Context = { params: Promise<{ workspaceId: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId } = await context.params
  const session = await governanceSession(request, workspaceId)
  return listServiceIdentities(workspaceId, session.user, new URL(request.url).searchParams.get('after'))
}))

export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return createServiceIdentity(workspaceId, session.user, await governanceJson(request))
}))
