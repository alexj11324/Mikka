import { WorkerEntrypoint } from 'cloudflare:workers'
import { Container, getContainer } from '@cloudflare/containers'
import { brokerRequest, identityRequest } from '../credential-identity/transport.mjs'

export { ContainerProxy } from '@cloudflare/containers'

export class CredentialBrokerRuntime extends Container {
  defaultPort = 3000
  sleepAfter = '5m'
  enableInternet = true

  constructor(ctx, env) {
    super(ctx, env)
    if (!env.CREDENTIAL_IDENTITY) throw new Error('CREDENTIAL_BROKER_CONFIGURATION_INVALID')
    this.envVars = {
      MIKKA_EDITION: 'cloud', CREDENTIAL_RUNTIME: 'cloudflare', CREDENTIAL_ENVIRONMENT: env.CREDENTIAL_ENVIRONMENT,
      NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
    }
    for (const name of ['CREDENTIAL_ENVIRONMENT', 'MIKKA_DATABASE_URL', 'CREDENTIAL_BROKER_ROLE_ARN', 'CREDENTIAL_KMS_KEY_ARN', 'AWS_REGION']) {
      if (typeof env[name] !== 'string' || !env[name]) throw new Error('CREDENTIAL_BROKER_CONFIGURATION_INVALID')
      this.envVars[name] = env[name]
    }
  }

  async start(...args) {
    await this.ctx.container.interceptOutboundHttps('identity.internal', this.ctx.exports.CredentialIdentityOutbound)
    return super.start(...args)
  }

  async startAndWaitForPorts(...args) {
    await this.ctx.container.interceptOutboundHttps('identity.internal', this.ctx.exports.CredentialIdentityOutbound)
    return super.startAndWaitForPorts(...args)
  }
}

export class CredentialIdentityOutbound extends WorkerEntrypoint {
  fetch(request) { return identityRequest(request, this.env.CREDENTIAL_IDENTITY) }
}

export class CredentialBroker extends WorkerEntrypoint {
  fetch(request) {
    return brokerRequest(request, forwarded => getContainer(this.env.CREDENTIAL_BROKER_RUNTIME, 'broker').fetch(forwarded))
  }
}

export default { fetch() { return new Response(null, { status: 404 }) } }
