import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { mcpOAuthStart } from '@/lib/plugins/connection-contracts'
import { mcpConnections } from '@/lib/plugins/runtime'

type Context = { params: Promise<{ id: string }> }
export const POST = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  await pluginBody(request, mcpOAuthStart)
  const id = await pluginUuidParam(ctx, 'id')
  const result = await mcpConnections.oauth.start(userId, id)
  return result.authorizationUrl ? result : mcpConnections.check(userId, id)
}))
