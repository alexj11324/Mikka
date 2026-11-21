import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { PluginError } from '@/lib/plugins/contracts'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { personalPlugins, mcpConnections } from '@/lib/plugins/runtime'
import { withRequestLog } from '@/lib/request-log'

const inputSchema = z.object({ serverId: z.uuid(), cursor: z.string().max(2048).optional() }).strict()

export const POST = freshSessionRoute(withRequestLog('/api/integrations/mcp/refresh', request => pluginResponse(async () => {
  const owner = await pluginActor(request, { humanOnly: true })
  const command = await pluginBody(request, inputSchema)
  const installation = (await personalPlugins.listMcp(owner)).find(server => server.id === command.serverId)
  if (!installation) throw new PluginError('mcpNotFound', 404)
  if (!installation.enabled || installation.transport === 'stdio') throw new PluginError('mcpUnavailable', 409)
  // The legacy refresh endpoint keeps its response while the common check
  // persists a complete tool snapshot and preserves switches across refreshes.
  const checked = await mcpConnections.check(owner, command.serverId)
  if (checked.status !== 'connected') throw new PluginError('mcpUnavailable', 503)
  return { serverId: command.serverId, tools: checked.tools.filter(tool => tool.available).map(tool => ({ name: tool.name })), nextCursor: null }
})))
