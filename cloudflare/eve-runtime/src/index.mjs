import { Container, getContainer } from '@cloudflare/containers'
import { hostConfiguration, nativeRequest } from '../runtime/config.mjs'
import { mayRestart, restartPlan, stoppedHost } from '../runtime/restarts.mjs'

const stateKey = 'mikka:eve-host:lifecycle:v1'
const retryCallback = 'restartAfterExit'
const expiryCallback = 'expireWarmLease'
const unavailable = () => Response.json({ ok: false, error: 'coordinatorUnavailable' }, {
  status: 503, headers: { 'cache-control': 'no-store' },
})

/** One shared Eve service, never a Task machine or a second Agent loop.
 * Cloudflare Queues wake the bound immutable release for pending work. */
export class EveRuntime extends Container {
  defaultPort = 8080
  sleepAfter = '1m'

  constructor(ctx, env) {
    super(ctx, env)
    this.configuration = hostConfiguration(env)
    let capability = ctx.storage.kv.get('eve-world-capability')
    if (!capability) {
      capability = crypto.randomUUID() + crypto.randomUUID()
      ctx.storage.kv.put('eve-world-capability', capability)
    }
    this.envVars = { ...this.configuration.runtimeEnv, MIKKA_EVE_WORLD_TOKEN: capability,
      NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt' }
    this.labels = { component: 'eve-runtime', release: this.configuration.releaseId }
  }

  async bindWorld() {
    await this.ctx.container.interceptOutboundHttps('world.internal',
      this.ctx.exports.EveWorldOutbound({ props: { capability: this.envVars.MIKKA_EVE_WORLD_TOKEN } }))
  }

  async start(...args) {
    await this.bindWorld()
    return super.start(...args)
  }

  async startAndWaitForPorts(...args) {
    await this.bindWorld()
    return super.startAndWaitForPorts(...args)
  }

  async fetch(request) {
    if (Date.now() >= this.configuration.warmUntil) return unavailable()
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
    if (Date.now() >= this.configuration.warmUntil) {
      await this.stopForOwner(this.configuration.releaseId)
      return
    }
    const accepted = await this.ctx.storage.transaction(async storage => {
      const current = await storage.get(stateKey)
      if (current?.stopped) return false
      if (current?.releaseId && current.releaseId !== this.configuration.releaseId) {
        throw new Error('CF_EVE_RELEASE_MISMATCH')
      }
      await storage.put(stateKey, {
        ...current, releaseId: this.configuration.releaseId, startedAt: Date.now(), stopped: false,
      })
      return true
    })
    if (!accepted) {
      await this.stop('SIGTERM')
      return
    }
    if (!(await this.listSchedules(expiryCallback)).length) {
      await this.schedule(new Date(this.configuration.warmUntil), expiryCallback, {
        releaseId: this.configuration.releaseId, warmUntil: this.configuration.warmUntil,
      })
    }
  }

  async onActivityExpired() {
    // Shared-service SLO, with max_instances=1 and explicit standby cost.
    // A settled Task must not destroy other people's Eve sessions.
    if (Date.now() >= this.configuration.warmUntil) await this.stopForOwner(this.configuration.releaseId)
    else this.renewActivityTimeout()
  }

  async onStop() {
    await this.queueRestart()
  }

  async queueRestart(executing) {
    const current = await this.ctx.storage.get(stateKey)
    if (current?.stopped) return
    if (Date.now() >= this.configuration.warmUntil) {
      await this.ctx.storage.put(stateKey, stoppedHost(current, this.configuration.releaseId))
      this.deleteSchedules(retryCallback)
      return
    }
    const pending = await this.listSchedules(retryCallback)
    // The SDK removes a one-shot schedule after its callback returns.
    if (pending.some(item => !executing || item.payload?.releaseId !== executing.releaseId
      || item.payload?.attempt !== executing.attempt)) return
    if (executing && !mayRestart(current, executing)) return
    const next = restartPlan(current, this.configuration.releaseId, Date.now())
    if (!next) {
      console.error('CF_EVE_RESTART_BUDGET_EXHAUSTED')
      return
    }
    await this.ctx.storage.put(stateKey, next)
    await this.schedule(new Date(next.dueAt), retryCallback, {
      releaseId: next.releaseId, attempt: next.attempt,
    })
  }

  async restartAfterExit(expected) {
    if (Date.now() >= this.configuration.warmUntil) return
    if (!mayRestart(await this.ctx.storage.get(stateKey), expected)) return
    try {
      await this.startAndWaitForPorts({
        ports: [this.defaultPort], cancellationOptions: { portReadyTimeoutMS: 180_000 },
      })
    } catch {
      console.error('CF_EVE_RESTART_FAILED')
      await this.queueRestart(expected)
    }
  }

  async expireWarmLease(expected) {
    if (expected?.releaseId !== this.configuration.releaseId
      || expected.warmUntil !== this.configuration.warmUntil
      || Date.now() < this.configuration.warmUntil) return
    await this.stopForOwner(this.configuration.releaseId)
  }

  /** Account/operator RPC only; the public fetch handler never exposes it. */
  async stopForOwner(expectedReleaseId) {
    if (expectedReleaseId !== this.configuration.releaseId) throw new Error('CF_EVE_RELEASE_MISMATCH')
    await this.ctx.storage.put(stateKey, stoppedHost(await this.ctx.storage.get(stateKey), expectedReleaseId))
    this.deleteSchedules(retryCallback)
    this.deleteSchedules(expiryCallback)
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
