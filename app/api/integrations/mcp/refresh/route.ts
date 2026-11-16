import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { PluginError } from '@/lib/plugins/contracts'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { personalPlugins, runPersonalMcp } from '@/lib/plugins/runtime'
import { withRequestLog } from '@/lib/request-log'

const inputSchema = z.object({ serverId: z.uuid(), cursor: z.string().max(2048).optional() }).strict()
const pageSchema = z.object({
  serverId: z.uuid(), tools: z.array(z.object({ name: z.string() })), nextCursor: z.string().max(2048).nullable(),
})

export const POST = freshSessionRoute(withRequestLog('/api/integrations/mcp/refresh', request => pluginResponse(async () => {
  const owner = await pluginActor(request, { humanOnly: true })
  const command = await pluginBody(request, inputSchema)
  const installation = (await personalPlugins.listMcp(owner)).find(server => server.id === command.serverId)
  if (!installation) throw new PluginError('mcpNotFound', 404)
  if (!installation.enabled || installation.transport === 'stdio') throw new PluginError('mcpUnavailable', 409)
  // Without a frozen execution grant the existing runtime can resolve only the owner's enabled connection.
  const result = await runPersonalMcp(owner, undefined, command)
  const page = pageSchema.safeParse(result)
  if (!page.success) throw new PluginError('mcpUnavailable', 503)
  return page.data
})))
