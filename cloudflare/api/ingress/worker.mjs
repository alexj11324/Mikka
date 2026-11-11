import { WorkerEntrypoint } from 'cloudflare:workers'
import { Container, getContainer } from '@cloudflare/containers'
import { apiRequest } from './request.mjs'
import { applicationEnvironment } from './environment.mjs'
import { configureTaskBridge, taskMachine } from './task-machine.mjs'
import { businessWorkflowDelivery, businessWorldRequest, eveServiceRequest, publicWorkflowDispatch } from './services.mjs'
export { ContainerProxy } from '@cloudflare/containers'

export class BusinessApi extends Container {
  defaultPort = 3000
  sleepAfter = '5m'
  enableInternet = true

  constructor(ctx, env) {
    super(ctx, env)
    this.envVars = applicationEnvironment(env)
    if (env.EVE_SERVICE || env.BUSINESS_WORLD) this.envVars.NODE_EXTRA_CA_CERTS = '/etc/cloudflare/certs/cloudflare-containers-ca.crt'
    if (env.EVE_SERVICE) this.envVars.MIKKA_EVE_ORIGIN = 'https://eve.internal'
    if (env.BUSINESS_WORLD) {
      this.envVars.WORKFLOW_TARGET_WORLD = '/app/world-business.mjs'
      let token = ctx.storage.kv.get('business-world.capability')
      if (!token) {
        token = crypto.randomUUID() + crypto.randomUUID()
        ctx.storage.kv.put('business-world.capability', token)
      }
      this.envVars.MIKKA_BUSINESS_WORLD_TOKEN = token
    }
    if (env.TASK_MACHINE) configureTaskBridge(this, ctx)
  }

  async configurePrivateHttps() {
    if (this.env.EVE_SERVICE) await this.ctx.container.interceptOutboundHttps('eve.internal', this.ctx.exports.EveOutbound)
    if (this.env.BUSINESS_WORLD) await this.ctx.container.interceptOutboundHttps('world.internal',
      this.ctx.exports.BusinessWorldOutbound({ props: { capability: this.envVars.MIKKA_BUSINESS_WORLD_TOKEN } }))
  }

  async start(...args) {
    await this.configurePrivateHttps()
    return super.start(...args)
  }

  async startAndWaitForPorts(...args) {
    await this.configurePrivateHttps()
    return super.startAndWaitForPorts(...args)
  }
}

export class EveOutbound extends WorkerEntrypoint {
  fetch(request) { return eveServiceRequest(request, this.env.EVE_SERVICE) }
}

export class BusinessWorldOutbound extends WorkerEntrypoint {
  fetch(request) { return businessWorldRequest(request, this.env.BUSINESS_WORLD, this.ctx.props.capability) }
}

export class BusinessWorkflowDelivery extends WorkerEntrypoint {
  fetch(request) {
    return businessWorkflowDelivery(request, this.env, forwarded => getContainer(this.env.BUSINESS_API, 'shared-api').fetch(forwarded))
  }
}

// Use the SDK setter so ContainerProxy registers the handler under this class.
BusinessApi.outboundHandlers = { taskMachine }

export default {
  fetch(request, env) {
    if (env.BUSINESS_WORLD && publicWorkflowDispatch(request.url)) return new Response(null, { status: 404 })
    const forwarded = apiRequest(request, env.PUBLIC_ORIGIN)
    if (!forwarded) return new Response(null, { status: 400, headers: { 'cache-control': 'no-store' } })
    // One active request or task never owns shutdown of the shared host.
    return getContainer(env.BUSINESS_API, 'shared-api').fetch(forwarded)
  },
}
