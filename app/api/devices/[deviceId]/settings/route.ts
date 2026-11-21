import { patchDeviceConcurrency } from '@/app/actions/settings'
import { settingsBody, settingsResponse, settingsWorkspaceQuery } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'

export const PATCH = freshSessionRoute(withRequestLog('/api/devices/[deviceId]/settings', async (request, context: { params: Promise<{ deviceId: string }> }) => {
  const { deviceId } = await context.params
  return settingsResponse(async () => patchDeviceConcurrency(deviceId, await settingsBody(request), settingsWorkspaceQuery(request)))
}))
