import { withRequestLog } from '@/lib/request-log'
import { getComposio } from '@/lib/composio'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { PluginError } from '@/lib/plugins/contracts'
import { connectWithCredentials, credentialConnectInput } from '@/lib/plugins/credential-connect'
import { credentialConnectDeps } from '@/lib/plugins/credential-connect-server'

/**
 * Connects an app with the person's own credentials (an API key, a token, a
 * login). The values go to Composio only; the response is the new account id,
 * never the values, and nothing about them is logged.
 */
export const POST = withRequestLog('/api/integrations/composio/credentials', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  const body = await pluginBody(request, credentialConnectInput)
  const client = getComposio()
  if (!client) throw new PluginError('composioNotConfigured', 503)
  return connectWithCredentials(credentialConnectDeps(client), userId, body)
}, 201))
