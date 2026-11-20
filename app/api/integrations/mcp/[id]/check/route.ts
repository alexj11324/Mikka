import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginResponse } from '@/lib/plugins/http'
import { mcpConnections } from '@/lib/plugins/runtime'
import { PluginError } from '@/lib/plugins/contracts'

type Context = { params: Promise<{ id: string }> }
const serverId = async (ctx: Context) => { const parsed = z.uuid().safeParse((await ctx.params).id); if (!parsed.success) throw new PluginError('invalidPluginInput', 400); return parsed.data }

export const POST = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  return mcpConnections.check(userId, await serverId(ctx))
}))
