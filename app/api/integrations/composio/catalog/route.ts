import { withRequestLog } from '@/lib/request-log'
import { getComposio } from '@/lib/composio'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginResponse } from '@/lib/plugins/http'
import { composioToolkitLister, listStoreCatalog } from '@/lib/plugins/catalog'

/** The 插件 store: every Composio toolkit a person can connect, with Composio's own sections. */
export const GET = withRequestLog('/api/integrations/composio/catalog', request => pluginResponse(async () => {
  await pluginActor(request)
  const client = getComposio()
  if (!client) return { configured: false, apps: [], popular: [], latest: [], categories: [] }
  return { configured: true, ...await listStoreCatalog(composioToolkitLister(client)) }
}))
