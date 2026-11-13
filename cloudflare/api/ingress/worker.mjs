import { bindWorkersAi, configureWorkersAi, workersAiRequest } from '../../workers-ai/binding.mjs'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { Container, getContainer } from '@cloudflare/containers'
import { apiRequest } from './request.mjs'
import { applicationEnvironment } from './environment.mjs'
import { configureTaskBridge, taskMachine } from './task-machine.mjs'
import { businessWorkflowDelivery, businessWorldRequest, eveServiceRequest, publicWorkflowDispatch } from './services.mjs'
import { brokerRequest, identityRequest } from '../../credential-identity/transport.mjs'
export { ContainerProxy } from '@cloudflare/containers'

export class BusinessApi extends Container {
  defaultPort = 3000
  sleepAfter = '5m'
  enableInternet = true

  constructor(ctx, env) {
    super(ctx, env)
    this.envVars = applicationEnvironment(env)
    if (env.EVE_SERVICE || env.BUSINESS_WORLD || env.CREDENTIAL_IDENTITY) this.envVars.NODE_EXTRA_CA_CERTS = '/etc/cloudflare/certs/cloudflare-containers-ca.crt'
    if (env.CREDENTIAL_IDENTITY || env.CREDENTIAL_BROKER) {
      if (!env.CREDENTIAL_IDENTITY || !env.CREDENTIAL_BROKER || !['preview', 'production'].includes(env.CREDENTIAL_ENVIRONMENT)) throw new Error('CREDENTIAL_API_CONFIGURATION_INVALID')
      this.envVars.CREDENTIAL_RUNTIME = 'cloudflare'
      for (const name of ['CREDENTIAL_ENVIRONMENT', 'CREDENTIAL_APP_ROLE_ARN', 'CREDENTIAL_KMS_KEY_ARN', 'AWS_REGION']) {
        if (typeof env[name] !== 'string' || !env[name]) throw new Error('CREDENTIAL_API_CONFIGURATION_INVALID')
        this.envVars[name] = env[name]
      }
    }
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
    if (env.WORKERS_AI) configureWorkersAi(this, ctx, env.CLOUDFLARE_WORKERS_AI_ACCOUNT_ID)
  }

  async configurePrivateHttps() {
    if (this.env.CREDENTIAL_IDENTITY) await this.ctx.container.interceptOutboundHttps('identity.internal', this.ctx.exports.CredentialIdentityOutbound)
    if (this.env.CREDENTIAL_BROKER) await this.ctx.container.interceptOutboundHttps('broker.internal', this.ctx.exports.CredentialBrokerOutbound)
    if (this.env.WORKERS_AI) await bindWorkersAi(this.ctx, this.envVars)
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

export class WorkersAiOutbound extends WorkerEntrypoint {
  fetch(request) { return workersAiRequest(request, this.env.WORKERS_AI, this.ctx.props.capability) }
}

export class CredentialIdentityOutbound extends WorkerEntrypoint {
  fetch(request) { return identityRequest(request, this.env.CREDENTIAL_IDENTITY) }
}

export class CredentialBrokerOutbound extends WorkerEntrypoint {
  fetch(request) {
    return brokerRequest(request, forwarded => this.env.CREDENTIAL_BROKER.fetch(forwarded))
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
