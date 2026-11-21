import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { mcpConnections, mcpDeviceChecks } from '@/lib/plugins/runtime'

type Context = { params: Promise<{ id: string }> }

export const POST = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  const id = await pluginUuidParam(ctx, 'id')
  const input = request.body ? await pluginBody(request, z.object({ deviceId: z.uuid().optional() }).strict()) : {}
  if (input.deviceId) {
    await mcpDeviceChecks.request(userId, id, input.deviceId)
    return mcpConnections.detail(userId, id)
  }
  return mcpConnections.check(userId, id)
}))
