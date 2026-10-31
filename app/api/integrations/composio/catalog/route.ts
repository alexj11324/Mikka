import { withRequestLog } from '@/lib/request-log'
import { getComposio } from '@/lib/composio'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginResponse } from '@/lib/plugins/http'
import { listAppCatalog } from '@/lib/plugins/catalog'

export const GET = withRequestLog('/api/integrations/composio/catalog', request => pluginResponse(async () => {
  await pluginActor(request)
  const client = getComposio()
  return { configured: Boolean(client), apps: client ? await listAppCatalog(client) : [] }
}))
