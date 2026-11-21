import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { mcpToolName, mcpToolSetting } from '@/lib/plugins/connection-contracts'
import { mcpConnections } from '@/lib/plugins/runtime'
import { PluginError } from '@/lib/plugins/contracts'

type Context = { params: Promise<{ id: string; name: string }> }
export const PATCH = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  const name = mcpToolName.safeParse((await ctx.params).name)
  if (!name.success) throw new PluginError('invalidPluginInput', 400)
  return mcpConnections.setTool(userId, await pluginUuidParam(ctx, 'id'), name.data, (await pluginBody(request, mcpToolSetting)).enabled)
}))
