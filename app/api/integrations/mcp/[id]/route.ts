import { z } from 'zod'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginResponse } from '@/lib/plugins/http'
import { mcpConnections } from '@/lib/plugins/runtime'
import { PluginError } from '@/lib/plugins/contracts'

type Context = { params: Promise<{ id: string }> }
const serverId = async (ctx: Context) => { const parsed = z.uuid().safeParse((await ctx.params).id); if (!parsed.success) throw new PluginError('invalidPluginInput', 400); return parsed.data }

export const GET = (request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request)
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') ?? undefined
  if (workspaceId && !z.uuid().safeParse(workspaceId).success) throw new PluginError('invalidPluginInput', 400)
  return mcpConnections.detail(userId, await serverId(ctx), workspaceId)
})
