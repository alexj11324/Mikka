import 'server-only'
import { cloudClient, cloudRequest } from './runtime'
import { CloudServiceError } from './errors'
import { readCloudJson } from './transport'

/** Read only on the person's explicit click. The issuing service supplies its
 * actual app path and selected billing workspace, never guessed from /cloud. */
export async function cloudModelBillingUrl(userId: string): Promise<string> {
  const connection = await cloudClient.capability(userId, 'models')
  if (!connection) throw new CloudServiceError('cloud_not_connected')
  const value = await readCloudJson(await cloudRequest(userId, 'models', '/v1/models/billing'))
  try {
    if (typeof value.url !== 'string') throw new CloudServiceError('cloud_unavailable', 'response')
    const url = new URL(value.url), service = new URL(connection.serviceUrl)
    if (url.protocol !== 'https:' || url.origin !== service.origin || url.username || url.password || url.hash
      || url.searchParams.get('section') !== 'billing' || !/^[0-9a-f-]{36}$/iu.test(url.searchParams.get('workspace') ?? '')) throw new CloudServiceError('cloud_unavailable', 'response')
    return url.href
  } catch (error) {
    if (error instanceof CloudServiceError) throw error
    throw new CloudServiceError('cloud_unavailable', 'response', error)
  }
}
