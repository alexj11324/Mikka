import { bindWorkersAi, configureWorkersAi } from '../../workers-ai/binding.mjs'
import { Container, getContainer } from '@cloudflare/containers'
import { hostConfiguration, nativeRequest } from '../runtime/config.mjs'

const stateKey = 'mikka:eve-host:lifecycle:v1'
const unavailable = () => Response.json({ ok: false, error: 'coordinatorUnavailable' }, {
  status: 503, headers: { 'cache-control': 'no-store' },
})

/** One shared Eve service, never a Task machine or a second Agent loop.
 * The Postgres World processes queued work inside the running Eve server. */
export class EveRuntime extends Container {
  defaultPort = 8080

  constructor(ctx, env) {
    super(ctx, env)
    this.configuration = hostConfiguration(env)
    let productCapability = ctx.storage.kv.get('eve-product-capability')
    if (!productCapability) {
      productCapability = crypto.randomUUID() + crypto.randomUUID()
      ctx.storage.kv.put('eve-product-capability', productCapability)
    }
    this.envVars = { ...this.configuration.runtimeEnv, MIKKA_EVE_PRODUCT_TOKEN: productCapability,
      NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt' }
    if (env.WORKERS_AI) configureWorkersAi(this, ctx, env.CLOUDFLARE_WORKERS_AI_ACCOUNT_ID)
    this.labels = { component: 'eve-runtime', release: this.configuration.releaseId }
  }

  async bindOutboundServices() {
    if (this.envVars.MIKKA_WORKERS_AI_CAPABILITY) await bindWorkersAi(this.ctx, this.envVars)
    await this.ctx.container.interceptOutboundHttps('product.internal',
      this.ctx.exports.EveProductOutbound({ props: { capability: this.envVars.MIKKA_EVE_PRODUCT_TOKEN } }))
  }

  async start(...args) {
    await this.bindOutboundServices()
    return super.start(...args)
  }

  async startAndWaitForPorts(...args) {
    await this.bindOutboundServices()
    return super.startAndWaitForPorts(...args)
  }

  async fetch(request) {
    const current = await this.ctx.storage.get(stateKey)
    if (current?.stopped || (current?.releaseId && current.releaseId !== this.configuration.releaseId)) return unavailable()
    try {
      const response = await super.fetch(request)
      if (response.status >= 500 && !response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel()
        return unavailable()
      }
      return response
    } catch {
      // SDK/network bodies can contain configuration; keep the product error closed.
      console.error('CF_EVE_TRANSPORT_UNAVAILABLE')
      return unavailable()
    }
  }

  async onStart() {
    const current = await this.ctx.storage.get(stateKey)
    if (current?.stopped) await this.stop('SIGTERM')
  }

  // Postgres queue workers need the server while no HTTP requests arrive.
  async onActivityExpired() {}

  async onStop() {
    if (!(await this.ctx.storage.get(stateKey))?.stopped) await this.startAndWaitForPorts()
  }

  /** Account/operator RPC only; the public fetch handler never exposes it. */
  async stopForOwner(expectedReleaseId) {
    if (expectedReleaseId !== this.configuration.releaseId) throw new Error('CF_EVE_RELEASE_MISMATCH')
    await this.ctx.storage.put(stateKey, { releaseId: expectedReleaseId, stopped: true })
    await this.stop('SIGTERM')
    return this.getState()
  }
}

export default {
  async fetch(request, env) {
    const forwarded = nativeRequest(request)
    if (!forwarded) return Response.json({ ok: false, error: 'notFound' }, { status: 404 })
    try {
      const configuration = hostConfiguration(env)
      return await getContainer(env.EVE_RUNTIME, configuration.releaseId).fetch(forwarded)
    } catch {
      console.error('CF_EVE_INGRESS_UNAVAILABLE')
      return unavailable()
    }
  },
}
