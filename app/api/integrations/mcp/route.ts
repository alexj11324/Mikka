import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { pluginActor } from '@/lib/plugins/actor'
import { createMcpSchema, deletePluginSchema, updateMcpSchema } from '@/lib/plugins/contracts'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { personalPlugins } from '@/lib/plugins/runtime'

export const GET = withRequestLog('/api/integrations/mcp', request => pluginResponse(async () => {
  const servers = await personalPlugins.listMcp(await pluginActor(request))
  return { servers, count: servers.length }
}))
const POSTBody = withRequestLog('/api/integrations/mcp', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  return { server: await personalPlugins.createMcp(userId, await pluginBody(request, createMcpSchema)) }
}, 201))
const PATCHBody = withRequestLog('/api/integrations/mcp', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  return { server: await personalPlugins.updateMcp(userId, await pluginBody(request, updateMcpSchema)) }
}))
const DELETEBody = withRequestLog('/api/integrations/mcp', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  await personalPlugins.deleteMcp(userId, (await pluginBody(request, deletePluginSchema)).id)
  return { deleted: true }
}))

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
export const PATCH = freshSessionRoute(PATCHBody)
export const DELETE = freshSessionRoute(DELETEBody)
