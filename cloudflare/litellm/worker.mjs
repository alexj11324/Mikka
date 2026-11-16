// The Mikka model gateway's protocol converter on Cloudflare Containers
// (decision 2026-11-15-2000; private runbook docs/operations/litellm.md).
// No public route: only the Mikka API reaches it, through its LITELLM service
// binding and the https://litellm.internal egress bridge. LiteLLM stores no
// provider key; each request carries the person's key and base URL, and the
// container checks the API's master key itself.
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
    this.envVars = { LITELLM_MASTER_KEY: env.LITELLM_MASTER_KEY }
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
