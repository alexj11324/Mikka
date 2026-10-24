import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { quotaSnapshotSchema, type QuotaSnapshot } from '@mikka/protocol'
import { authorizeSubscriptionUse, SubscriptionRefusal, type SubscriptionAccess, type SubscriptionRoute, type SubscriptionUse } from '@mikka/protocol/subscription'
import type { SubscriptionWorkerClient, NativeLease, WorkerMetadata } from '../packages/daemon/src/subscription-worker-client'
import { readSubscriptionQuota } from '../packages/daemon/src/subscription-quota'
import { SubscriptionRepository } from './subscription-repository'
import { resolveSubscriptionModel } from './subscription-model'

export interface SubscriptionCapabilities {
  ready(route: SubscriptionRoute): boolean
  nativeIsolation: 'verified_runtime' | 'none'
  oauth?: Partial<Record<'codex' | 'claude', boolean>>
}
export class SubscriptionService {
  constructor(readonly repository: SubscriptionRepository,
    readonly worker: (scope: ReturnType<SubscriptionRepository['scope']>) => SubscriptionWorkerClient,
    readonly capabilities: SubscriptionCapabilities,
    readonly quota: (provider: 'codex' | 'claude', lease: NativeLease, signal?: AbortSignal) => Promise<QuotaSnapshot> = (provider, lease, signal) => readSubscriptionQuota(provider, lease, fetch, signal),
    readonly workspace: (ownerId: string, workspaceId: string) => Promise<void> = async () => { throw new SubscriptionRefusal('account_unavailable') }) {}

  async access(use: SubscriptionUse, signal?: AbortSignal): Promise<SubscriptionAccess> {
    const { modelId: _, ...binding } = await this.repository.binding(use.ownerId, use.bindingId)
    if (binding.workspaceId !== use.workspaceId || binding.consumerId !== use.consumerId) throw new SubscriptionRefusal('binding_mismatch')
    await this.workspace(use.ownerId, binding.workspaceId)
    const row = await this.repository.connection(use.ownerId, binding.connectionId)
    const revision = Number(row.epoch)
    const readiness = this.capabilities.ready(binding.route) ? 'ready' : 'unavailable'
    const baseQuota = { vendor: row.provider === 'codex' ? 'codex' : 'claude_code', status: 'unknown', source: 'local_credentials', plan: null, observedAt: new Date().toISOString(), windows: [] }
    let quota = quotaSnapshotSchema.safeParse(row.quota).data ?? quotaSnapshotSchema.parse(baseQuota)
    // Probe only after scope/state/revision and server-side capability checks.
    if (readiness === 'ready' && row.state === 'connected' && revision === binding.connectionRevision && (quota.status !== 'ok' || Date.now() - Date.parse(quota.observedAt) > 45_000)) {
      const lease = await this.worker(this.repository.scope(row)).call<NativeLease>('nativeAuth', { revision }, signal)
      quota = quotaSnapshotSchema.parse(await this.quota(row.provider, lease, signal))
      await this.repository.saveQuota(row, quota)
    }
    // Re-read after async quota probing: disconnect/reconnect must win.
    const current = await this.repository.connection(use.ownerId, row.id)
    return {
      binding,
      credentialTransition: current.state === 'refreshing' ? 'refreshing' : current.state === 'publication_pending' ? 'publication_pending' : undefined,
      connection: { id: row.id, ownerId: row.ownerId, workspaceId: row.workspaceId, provider: row.provider === 'codex' ? 'openai' : 'anthropic', revision: Number(current.epoch), state: current.state === 'connected' ? 'connected' : current.state === 'disconnected' ? 'disconnected' : current.state === 'pending' ? 'pending' : 'reconnect_required', quota },
      backend: { connectionId: row.id, connectionRevision: revision, ownerId: row.ownerId, workspaceId: row.workspaceId, route: binding.route, readiness, billing: 'subscription_only', isolation: use.execution === 'native' ? this.capabilities.nativeIsolation : 'credential_broker' }
    }
  }
  async model(use: SubscriptionUse, signal?: AbortSignal) {
    const binding = await this.repository.binding(use.ownerId, use.bindingId)
    const row = await this.repository.connection(use.ownerId, binding.connectionId)
    const client = this.worker(this.repository.scope(row))
    return resolveSubscriptionModel(use, binding.modelId, {
      access: () => this.access(use, signal),
      model: async modelId => {
        const provider = createOpenAICompatible({ name: 'mikka-subscription', baseURL: 'https://mikka.invalid/v1', apiKey: 'private-worker-placeholder',
          fetch: async (_url, init) => {
            if (typeof init?.body !== 'string' || init.body.length > 262144) throw new SubscriptionRefusal('backend_unavailable')
            const payload = JSON.parse(init.body)
            if (payload.model !== binding.modelId || payload.stream !== true) throw new SubscriptionRefusal('binding_mismatch')
            await this.check(use, signal)
            return new Response(client.stream(binding.connectionRevision, modelId, payload, init.signal ?? signal ?? undefined), { headers: { 'content-type': 'text/event-stream' } })
          }
        })
        const model = provider(modelId)
        const doStream = model.doStream.bind(model)
        model.doStream = async options => {
          try {
            const result = await doStream(options)
            const reader = result.stream.getReader()
            let closed = false
            const stream: typeof result.stream = new ReadableStream({
              async pull(controller) {
                try {
                  const { value, done } = await reader.read()
                  if (closed) return
                  if (done) { closed = true; reader.releaseLock(); controller.close(); return }
                  controller.enqueue(value.type === 'error' ? { type: 'error', error: new Error('subscription_generation_failed') } : value)
                } catch {
                  if (closed) return
                  closed = true; reader.releaseLock()
                  controller.enqueue({ type: 'error', error: new Error('subscription_generation_failed') }); controller.close()
                }
              },
              async cancel(reason) { closed = true; await reader.cancel(reason); reader.releaseLock() }
            })
            return { ...result, stream }
          } catch { throw new SubscriptionRefusal('backend_unavailable') }
        }
        return model
      }
    })
  }
  async check(use: SubscriptionUse, signal?: AbortSignal) { return authorizeSubscriptionUse(use, await this.access(use, signal)) }
  async launchNative<T>(ownerId: string, consumerId: string, bindingId: string, run: (context: { use: SubscriptionUse; modelId: string; worker: Pick<SubscriptionWorkerClient, 'call'>; access(): Promise<SubscriptionAccess> }) => Promise<T>) {
    const binding = await this.repository.binding(ownerId, bindingId)
    const use: SubscriptionUse = { ownerId, consumerId, bindingId, workspaceId: binding.workspaceId, execution: 'native' }
    await this.check(use)
    const row = await this.repository.connection(ownerId, binding.connectionId)
    return run({ use, modelId: binding.modelId, access: () => this.access(use), worker: this.worker(this.repository.scope(row)) })
  }
  async status(ownerId: string, id: string, signal?: AbortSignal) {
    const row = await this.repository.connection(ownerId, id)
    const status = await this.worker(this.repository.scope(row)).call<WorkerMetadata>('status', {}, signal)
    return { id: row.id, provider: row.provider, state: status.state, revision: status.revision }
  }
}
