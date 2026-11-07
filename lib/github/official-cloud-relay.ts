import { isCloudEdition } from '@/lib/edition'
import { CloudServiceError } from '@/lib/cloud-services/errors'

/** Operator-owned runtime configuration, shared with the platform rewrite.
 * A request can never choose the receiving host, path, or credentials. */
export function officialGitHubRelayEndpoint(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (!isCloudEdition(env) || !env.MIKKA_CLOUD_BACKEND_URL) return null
  let target: URL
  try { target = new URL(env.MIKKA_CLOUD_BACKEND_URL) }
  catch (cause) { throw new CloudServiceError('cloud_invalid_request', 'configuration', cause) }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash
    || target.pathname !== '/' || target.origin !== env.MIKKA_CLOUD_BACKEND_URL) throw new CloudServiceError('cloud_invalid_request', 'configuration')
  return `${target.origin}/mikka/cloud/v1/github/webhook`
}

/** The caller has already verified GitHub's raw-body HMAC. Preserve it so the
 * private broker verifies it independently before associating any delivery. */
export async function relayOfficialGitHubWebhook(delivery: { event: string | null; deliveryId: string | null; signature: string | null; body: string },
  options: { env?: Readonly<Record<string, string | undefined>>; send?: typeof fetch } = {}): Promise<void> {
  const endpoint = officialGitHubRelayEndpoint(options.env)
  if (!endpoint) return
  const { event, deliveryId, signature, body } = delivery
  if (!event || !/^[a-z_]{1,100}$/.test(event) || !deliveryId || !/^[A-Za-z0-9-]{1,100}$/.test(deliveryId)
    || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) throw new CloudServiceError('cloud_invalid_request', 'protocol')
  let response: Response
  try {
    response = await (options.send ?? fetch)(endpoint, { method: 'POST', body, redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(8_000),
      headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': deliveryId, 'x-hub-signature-256': signature } })
  } catch (cause) { throw new CloudServiceError('cloud_unavailable', 'network', cause) }
  await response.body?.cancel()
  if (!response.ok) throw new CloudServiceError('cloud_unavailable', 'response')
}
