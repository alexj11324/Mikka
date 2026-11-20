import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { personalPlugins } from '@/lib/plugins/runtime'
import { addCatalogMcp, installMcpCatalog, searchMcpCatalog } from '@/lib/plugins/mcp-catalog'

export const GET = (request: Request) => pluginResponse(async () => {
  await pluginActor(request)
  const query = new URL(request.url).searchParams
  return searchMcpCatalog(query.get('q') ?? '', query.get('cursor') ?? undefined)
})
export const POST = freshSessionRoute((request: Request) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  return { server: await addCatalogMcp(personalPlugins, userId, await pluginBody(request, installMcpCatalog)) }
}, 201))
