import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { mcpConnections } from '@/lib/plugins/runtime'
import { PluginError } from '@/lib/plugins/contracts'

type Context = { params: Promise<{ id: string }> }

export const GET = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  const query = new URL(request.url).searchParams
  const input = z.object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(256), issuer: z.string().max(2048).optional() }).safeParse({
    code: query.get('code'), state: query.get('state'), issuer: query.get('iss') ?? undefined,
  })
  if (!input.success) throw new PluginError('mcpOAuthStateInvalid', 400)
  const id = await pluginUuidParam(ctx, 'id')
  await mcpConnections.oauth.callback(userId, id, input.data)
  return mcpConnections.check(userId, id)
}))
