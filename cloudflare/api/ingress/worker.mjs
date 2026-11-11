import { Container, getContainer } from '@cloudflare/containers'
import { apiRequest } from './request.mjs'
import { configureTaskBridge, taskMachine } from './task-machine.mjs'
export { ContainerProxy } from '@cloudflare/containers'

export class BusinessApi extends Container {
  defaultPort = 3000
  sleepAfter = '5m'
  enableInternet = true

  constructor(ctx, env) {
    super(ctx, env)
    // Only this private workload receives the app's bindings. Give every
    // replica the same stable secrets and separate Eve origin on every boot.
    this.envVars = { BETTER_AUTH_URL: env.PUBLIC_ORIGIN, MIKKA_API_INGRESS: 'cloudflare' }
    for (const key of ['BETTER_AUTH_SECRET', 'DATABASE_URL', 'MIKKA_DATABASE_URL',
      'MIKKA_EVE_ORIGIN', 'WORKFLOW_TARGET_WORLD', 'MIN_CLIENT_VERSION',
      'R2_ACCOUNT_ID', 'R2_ARTIFACTS_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
      if (env[key]) this.envVars[key] = env[key]
    }
    if (env.TASK_MACHINE) configureTaskBridge(this, ctx)
  }
}

// Use the SDK setter so ContainerProxy registers the handler under this class.
BusinessApi.outboundHandlers = { taskMachine }

export default {
  fetch(request, env) {
    const forwarded = apiRequest(request, env.PUBLIC_ORIGIN)
    if (!forwarded) return new Response(null, { status: 400, headers: { 'cache-control': 'no-store' } })
    // One active request or task never owns shutdown of the shared host.
    return getContainer(env.BUSINESS_API, 'shared-api').fetch(forwarded)
  },
}
