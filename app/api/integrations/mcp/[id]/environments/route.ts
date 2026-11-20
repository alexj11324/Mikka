import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { mcpConnections } from '@/lib/plugins/runtime'
import { PluginError } from '@/lib/plugins/contracts'

type Context = { params: Promise<{ id: string }> }
const serverId = async (ctx: Context) => { const parsed = z.uuid().safeParse((await ctx.params).id); if (!parsed.success) throw new PluginError('invalidPluginInput', 400); return parsed.data }

import { mcpEnvironmentSettings } from '@/lib/plugins/connection-contracts'
export const PATCH = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  return mcpConnections.setEnvironments(userId, await serverId(ctx), await pluginBody(request, mcpEnvironmentSettings))
}))
