import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { mcpEnvironmentSettings } from '@/lib/plugins/connection-contracts'
import { mcpConnections } from '@/lib/plugins/runtime'

type Context = { params: Promise<{ id: string }> }
export const PATCH = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  return mcpConnections.setEnvironments(userId, await pluginUuidParam(ctx, 'id'), await pluginBody(request, mcpEnvironmentSettings))
}))
