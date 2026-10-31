import { withRequestLog } from '@/lib/request-log'
import { pluginActor } from '@/lib/plugins/actor'
import { createMcpSchema, deletePluginSchema, updateMcpSchema } from '@/lib/plugins/contracts'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { personalPlugins } from '@/lib/plugins/runtime'

export const GET = withRequestLog('/api/integrations/mcp', request => pluginResponse(async () => {
  const servers = await personalPlugins.listMcp(await pluginActor(request))
  return { servers, count: servers.length }
}))
export const POST = withRequestLog('/api/integrations/mcp', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  return { server: await personalPlugins.createMcp(userId, await pluginBody(request, createMcpSchema)) }
}, 201))
export const PATCH = withRequestLog('/api/integrations/mcp', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  return { server: await personalPlugins.updateMcp(userId, await pluginBody(request, updateMcpSchema)) }
}))
export const DELETE = withRequestLog('/api/integrations/mcp', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  await personalPlugins.deleteMcp(userId, (await pluginBody(request, deletePluginSchema)).id)
  return { deleted: true }
}))
