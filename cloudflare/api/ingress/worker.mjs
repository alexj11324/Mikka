import { WorkerEntrypoint } from 'cloudflare:workers'
import { Container } from '@cloudflare/containers'
import { apiRequest } from './request.mjs'
import { applicationEnvironment } from './environment.mjs'
import { configureTaskBridge, taskMachine } from './task-machine.mjs'
import { businessWorkflowDelivery, businessWorldRequest, eveServiceRequest, liteLlmRequest, publicWorkflowDispatch } from './services.mjs'
import { brokerRequest, identityRequest } from '../../credential-identity/transport.mjs'
export { ContainerProxy } from '@cloudflare/containers'

export class BusinessApi extends Container {
  defaultPort = 3000
  sleepAfter = '5m'
  enableInternet = true

  constructor(ctx, env) {
    super(ctx, env)
    this.envVars = applicationEnvironment(env)
    if (env.EVE_SERVICE || env.BUSINESS_WORLD || env.CREDENTIAL_IDENTITY || env.LITELLM) this.envVars.NODE_EXTRA_CA_CERTS = '/etc/cloudflare/certs/cloudflare-containers-ca.crt'
    if (env.CREDENTIAL_IDENTITY || env.CREDENTIAL_BROKER) {
      if (!env.CREDENTIAL_IDENTITY || !env.CREDENTIAL_BROKER) throw new Error('CREDENTIAL_API_CONFIGURATION_INVALID')
      this.envVars.CREDENTIAL_RUNTIME = 'cloudflare'
      for (const name of ['CREDENTIAL_ENVIRONMENT', 'CREDENTIAL_APP_ROLE_ARN', 'CREDENTIAL_KMS_KEY_ARN', 'AWS_REGION']) {
        if (typeof env[name] !== 'string' || !env[name]) throw new Error('CREDENTIAL_API_CONFIGURATION_INVALID')
        this.envVars[name] = env[name]
      }
    }
    if (env.EVE_SERVICE) this.envVars.MIKKA_EVE_ORIGIN = 'https://eve.internal'
    // The protocol converter is a private service; the master key arrives as the API's own secret.
    if (env.LITELLM) this.envVars.MIKKA_LITELLM_URL = 'https://litellm.internal'
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
    if (this.env.CREDENTIAL_IDENTITY) await this.ctx.container.interceptOutboundHttps('identity.internal', this.ctx.exports.CredentialIdentityOutbound)
    if (this.env.CREDENTIAL_BROKER) await this.ctx.container.interceptOutboundHttps('broker.internal', this.ctx.exports.CredentialBrokerOutbound)
    if (this.env.EVE_SERVICE) await this.ctx.container.interceptOutboundHttps('eve.internal', this.ctx.exports.EveOutbound)
    if (this.env.LITELLM) await this.ctx.container.interceptOutboundHttps('litellm.internal', this.ctx.exports.LiteLlmOutbound)
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

export class LiteLlmOutbound extends WorkerEntrypoint {
  fetch(request) { return liteLlmRequest(request, this.env.LITELLM) }
}

export class BusinessWorldOutbound extends WorkerEntrypoint {
  fetch(request) { return businessWorldRequest(request, this.env.BUSINESS_WORLD, this.ctx.props.capability) }
}

export class BusinessWorkflowDelivery extends WorkerEntrypoint {
  fetch(request) {
    return businessWorkflowDelivery(request, this.env, forwarded => this.env.BUSINESS_API.getByName('shared-api').fetch(forwarded))
  }
}

// Use the SDK setter so ContainerProxy registers the handler under this class.
BusinessApi.outboundHandlers = { taskMachine }

export default class ApiIngress extends WorkerEntrypoint {
  fetch(request) {
    const env = this.env
    if (env.BUSINESS_WORLD && publicWorkflowDispatch(request.url)) return new Response(null, { status: 404 })
    const forwarded = apiRequest(request, env.PUBLIC_ORIGIN)
    if (!forwarded) return new Response(null, { status: 400, headers: { 'cache-control': 'no-store' } })
    // One active request or task never owns shutdown of the shared host.
    return env.BUSINESS_API.getByName('shared-api').fetch(forwarded)
  }

  eveProduct(request, scope) {
    const url = new URL(request.url)
    if (request.method !== 'POST' || !['/mikka/api/internal/eve/tools', '/mikka/api/internal/eve/slack-credential'].includes(url.pathname)) return new Response(null, { status: 404 })
    if (typeof scope !== 'string' || scope.length > 2048) return new Response(null, { status: 403 })
    const forwarded = apiRequest(request, this.env.PUBLIC_ORIGIN)
    if (!forwarded) return new Response(null, { status: 400 })
    forwarded.headers.delete('authorization')
    forwarded.headers.delete('cookie')
    forwarded.headers.set('x-mikka-eve-binding-scope', scope)
    return this.env.BUSINESS_API.getByName('shared-api').fetch(forwarded)
  }
}
