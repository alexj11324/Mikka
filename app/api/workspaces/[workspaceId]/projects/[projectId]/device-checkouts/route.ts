import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { listDeviceCheckouts } from '@/lib/project-resources/device-checkouts'

export const runtime = 'nodejs'
type Context = { params: Promise<{ workspaceId: string; projectId: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const params = await context.params
  const session = await governanceSession(request, params.workspaceId)
  return listDeviceCheckouts(session, params)
}))
