import { z } from 'zod'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginResponse } from '@/lib/plugins/http'
import { mcpConnections } from '@/lib/plugins/runtime'
import { PluginError } from '@/lib/plugins/contracts'

export const GET = (request: Request) => pluginResponse(async () => {
  const userId = await pluginActor(request)
  const query = new URL(request.url).searchParams
  const input = z.object({ workspaceId: z.uuid().optional(), environmentId: z.uuid().optional(), query: z.string().max(200).optional() }).safeParse({
    workspaceId: query.get('workspaceId') ?? undefined, environmentId: query.get('environmentId') ?? undefined, query: query.get('q') ?? undefined,
  })
  if (!input.success) throw new PluginError('invalidPluginInput', 400)
  return mcpConnections.search(userId, input.data)
})
