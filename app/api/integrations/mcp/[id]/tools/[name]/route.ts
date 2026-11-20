import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { mcpConnections } from '@/lib/plugins/runtime'
import { PluginError } from '@/lib/plugins/contracts'

type Context = { params: Promise<{ id: string; name: string }> }
const serverId = async (ctx: Context) => { const parsed = z.uuid().safeParse((await ctx.params).id); if (!parsed.success) throw new PluginError('invalidPluginInput', 400); return parsed.data }

import { mcpToolName, mcpToolSetting } from '@/lib/plugins/connection-contracts'
export const PATCH = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  const name = mcpToolName.safeParse((await ctx.params).name)
  if (!name.success) throw new PluginError('invalidPluginInput', 400)
  return mcpConnections.setTool(userId, await serverId(ctx), name.data, (await pluginBody(request, mcpToolSetting)).enabled)
}))
