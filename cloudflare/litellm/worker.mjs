// Private model egress reached only through the API Worker's LITELLM binding.
import { WorkerEntrypoint } from 'cloudflare:workers'
import { Container, getContainer } from '@cloudflare/containers'
export { ContainerProxy } from '@cloudflare/containers'
import { converterRequest } from './request.mjs'

export class LiteLlm extends Container {
  defaultPort = 4000
  // Stateless: it sleeps when idle and the next request wakes it.
  sleepAfter = '5m'
  // Provider endpoints are public HTTPS services.
  enableInternet = true

  constructor(ctx, env) {
    super(ctx, env)
    if (typeof env.LITELLM_MASTER_KEY !== 'string' || env.LITELLM_MASTER_KEY.length < 32) throw new Error('LITELLM_CONFIGURATION_INVALID')
    this.envVars = {
      LITELLM_MASTER_KEY: env.LITELLM_MASTER_KEY,
      AI_GATEWAY_API_KEY: env.AI_GATEWAY_API_KEY ?? '',
      NEON_AI_GATEWAY_BASE_URL: env.NEON_AI_GATEWAY_BASE_URL ?? '',
      NEON_AI_GATEWAY_TOKEN: env.NEON_AI_GATEWAY_TOKEN ?? '',
    }
  }
}

export default class LiteLlmService extends WorkerEntrypoint {
  fetch(request) {
    const forwarded = converterRequest(request)
    if (!forwarded) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
    // One shared instance: every request is independent.
    return getContainer(this.env.LITELLM_CONTAINER, 'shared').fetch(forwarded)
  }
}
