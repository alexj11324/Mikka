import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { readDeviceSettingsDetail } from '@/lib/settings/device-detail'

export const GET = freshSessionRoute(async (request: Request, { params }: { params: Promise<{ deviceId: string }> }) => governanceResponse(async () => {
  const { deviceId } = await params
  const workspaceId = z.uuid().parse(new URL(request.url).searchParams.get('workspaceId'))
  const session = await governanceSession(request, workspaceId)
  return readDeviceSettingsDetail(session.user, { workspaceId, deviceId })
}))
