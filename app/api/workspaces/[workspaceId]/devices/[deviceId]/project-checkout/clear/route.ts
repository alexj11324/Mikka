import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession, governanceResponse } from '@/lib/governance/http'
import { clearCheckoutBody, writeDeviceCheckout } from '@/lib/project-resources/device-checkouts'

type Context = { params: Promise<{ workspaceId: string; deviceId: string }> }

export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const params = await context.params
  const session = await governanceMutationSession(request, params.workspaceId)
  const body = clearCheckoutBody.parse(await governanceJson(request))
  await writeDeviceCheckout(session, { ...params, projectId: body.projectId }, null)
  return new Response(null, { status: 204, headers: { 'cache-control': 'private, no-store' } })
}))
