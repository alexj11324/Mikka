import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession, governanceResponse } from '@/lib/governance/http'
import { setCheckoutBody, writeDeviceCheckout } from '@/lib/project-resources/device-checkouts'

export const runtime = 'nodejs'
type Context = { params: Promise<{ workspaceId: string; deviceId: string }> }

export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const params = await context.params
  const session = await governanceMutationSession(request, params.workspaceId)
  const body = setCheckoutBody.parse(await governanceJson(request))
  return writeDeviceCheckout(session, { ...params, projectId: body.projectId }, body.root)
}))
