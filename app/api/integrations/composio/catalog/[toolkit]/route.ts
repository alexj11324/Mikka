import { withRequestLog } from '@/lib/request-log'
import { getComposio } from '@/lib/composio'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginResponse } from '@/lib/plugins/http'
import { composioAppDetailSource, readAppDetail } from '@/lib/plugins/app-detail'
import { PluginError } from '@/lib/plugins/contracts'

/** One store app's page: Composio's description, tools and facts. Needs a signed-in person, not a connected account. */
export const GET = withRequestLog('/api/integrations/composio/catalog/[toolkit]', (request: Request, context: { params: Promise<{ toolkit: string }> }) => pluginResponse(async () => {
  await pluginActor(request)
  const client = getComposio()
  if (!client) throw new PluginError('composioNotConfigured', 503)
  const { toolkit } = await context.params
  return readAppDetail(composioAppDetailSource(client), toolkit)
}))
