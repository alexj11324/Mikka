import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { mcpConnections, mcpDeviceChecks } from '@/lib/plugins/runtime'
import { PluginError } from '@/lib/plugins/contracts'

type Context = { params: Promise<{ id: string }> }
const serverId = async (ctx: Context) => { const parsed = z.uuid().safeParse((await ctx.params).id); if (!parsed.success) throw new PluginError('invalidPluginInput', 400); return parsed.data }

export const POST = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  const id = await serverId(ctx)
  const input = request.body ? await pluginBody(request, z.object({ deviceId: z.uuid().optional() }).strict()) : {}
  if (input.deviceId) {
    await mcpDeviceChecks.request(userId, id, input.deviceId)
    return mcpConnections.detail(userId, id)
  }
  return mcpConnections.check(userId, id)
}))
