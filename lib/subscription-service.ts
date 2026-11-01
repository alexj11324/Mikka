import { workerSubscriptionMatches } from './agent-kit/worker'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { quotaSnapshotSchema, type QuotaSnapshot } from '@mikka/protocol'
import { authorizeSubscriptionUse, SubscriptionRefusal, type SubscriptionAccess, type SubscriptionRoute, type SubscriptionUse } from '@mikka/protocol/subscription'
import type { SubscriptionWorkerClient, WorkerMetadata } from '../packages/daemon/src/subscription-worker-client'
import { readSubscriptionQuota } from '../packages/daemon/src/subscription-quota'
import { SubscriptionRepository } from './subscription-repository'
import { resolveSubscriptionModel } from './subscription-model'
import { nativeBrokerContextSchema, nativeLeaseSchema, type NativeBrokerRequest } from '@mikka/protocol/subscription'
import { accountLabel, failedUsage, parseSubscriptionUsage, type SubscriptionUsage, type WorkerUsage } from './subscription-usage'

export interface SubscriptionCapabilities {
  ready(route: SubscriptionRoute): boolean
  nativeIsolation: 'verified_runtime' | 'none'
  oauth?: Partial<Record<'codex' | 'claude', boolean>>
}
export class SubscriptionService {
  constructor(readonly repository: SubscriptionRepository,
    readonly worker: (scope: ReturnType<SubscriptionRepository['scope']>) => SubscriptionWorkerClient,
    readonly capabilities: SubscriptionCapabilities,
    readonly quota: (provider: 'codex' | 'claude', result: {status: number; body: unknown}) => Promise<QuotaSnapshot> | QuotaSnapshot = readSubscriptionQuota,
    readonly workspace: (ownerId: string, workspaceId: string, consumerId?: string) => Promise<void> = async () => { throw new SubscriptionRefusal('account_unavailable') },
    readonly admitModel: (scope: { ownerId: string; workspaceId: string; runId?: string }, model: string, route: string, signal?: AbortSignal) => Promise<void> = async (...args) => {
      const { assertSubscriptionModelTransport } = await import('./model-admission/runtime')
      await assertSubscriptionModelTransport(...args)
    }) {}

  async access(use: SubscriptionUse, signal?: AbortSignal): Promise<SubscriptionAccess> {
    const { modelId: _, ...binding } = await this.repository.binding(use.ownerId, use.bindingId)
    if (binding.workspaceId !== use.workspaceId || binding.consumerId !== use.consumerId) throw new SubscriptionRefusal('binding_mismatch')
    await this.workspace(use.ownerId, binding.workspaceId, binding.consumerId)
    const row = await this.repository.connection(use.ownerId, binding.connectionId)
    const revision = Number(row.epoch)
    const readiness = this.capabilities.ready(binding.route) ? 'ready' : 'unavailable'
    const baseQuota = { vendor: row.provider === 'codex' ? 'codex' : 'claude_code', status: 'unknown', source: 'local_credentials', plan: null, observedAt: new Date().toISOString(), windows: [] }
    let quota = quotaSnapshotSchema.safeParse(row.quota).data ?? quotaSnapshotSchema.parse(baseQuota)
    // Probe only after scope/state/revision and server-side capability checks.
    if ((use.execution !== 'native' || this.capabilities.nativeIsolation === 'verified_runtime') && readiness === 'ready' && row.state === 'connected' && revision === binding.connectionRevision && (quota.status !== 'ok' || Date.now() - Date.parse(quota.observedAt) > 45_000)) {
      const client = this.worker(this.repository.scope(row)).forUse(use)
      await client.call('prepare', { revision }, signal)
      const result = await client.call<{status: number; body: unknown}>('quota', { revision }, signal)
      quota = quotaSnapshotSchema.parse(await this.quota(row.provider, result))
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
    const admit = async (callSignal = signal) => {
      await this.admitModel({ workspaceId: binding.workspaceId, ownerId: use.ownerId }, binding.modelId, binding.route, callSignal)
    }
    await admit()
    const row = await this.repository.connection(use.ownerId, binding.connectionId)
    const client = this.worker(this.repository.scope(row)).forUse(use)
    return resolveSubscriptionModel(use, binding.modelId, {
      access: () => this.access(use, signal),
      model: async modelId => {
        const provider = createOpenAICompatible({ name: 'mikka-subscription', baseURL: 'https://mikka.invalid/v1', apiKey: 'private-worker-placeholder',
          fetch: async (_url, init) => {
            if (typeof init?.body !== 'string' || init.body.length > 262144) throw new SubscriptionRefusal('backend_unavailable')
            const payload = JSON.parse(init.body)
            if (payload.model !== binding.modelId || payload.stream !== true) throw new SubscriptionRefusal('binding_mismatch')
            await this.check(use, signal)
            await admit(init.signal ?? signal ?? undefined)
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
  async nativeRun(ownerId: string, deviceId: string, runId: string) {
    const { rows } = await this.repository.pool.query(`select b.id,b."workspaceId",b."consumerId",b.route,b."modelId",r."agentDefinition",a.harness from byos_native_runs n join agent_runs r on r.id=n."runId" join agents a on a.id=r."agentId" join devices d on d.id=r."deviceId" and d."ownerId"=r."userId" and d.enabled=true join byos_bindings b on b.id=n."bindingId" where r.id=$1 and r."userId"=$2 and r."deviceId"=$3 and a."userId"=$2 and b."ownerId"=$2 and b."consumerId"=a.id::text and d.harnesses @> jsonb_build_array(jsonb_build_object('harness',coalesce(r."agentDefinition"->>'harness',a.harness),'installed',true,'subscriptionBroker',true)) and r.status in ('preparing','running','paused','waiting_input') and r."leaseExpiresAt">now() and r."stopRequestedAt" is null`, [runId,ownerId,deviceId])
    if (!rows[0]) throw new SubscriptionRefusal('account_unavailable')
    const row=rows[0]
    if (!workerSubscriptionMatches(row.agentDefinition,row.harness,row)) throw new SubscriptionRefusal('binding_mismatch')
    return {ownerId,workspaceId:row.workspaceId,consumerId:row.consumerId,bindingId:row.id,execution:'native',runId} as const
  }
  async nativeContext(use: SubscriptionUse, signal?: AbortSignal) {
    const binding=await this.repository.binding(use.ownerId,use.bindingId)
    const selected = await this.nativeSelectedModel(use, binding.modelId)
    await this.admitModel({ ownerId: use.ownerId, workspaceId: binding.workspaceId, runId: use.runId }, selected ?? binding.modelId, binding.route, signal)
    const authorized=await this.check(use,signal)
    await this.admitModel({ ownerId: use.ownerId, workspaceId: binding.workspaceId, runId: use.runId }, selected ?? binding.modelId, binding.route, signal)
    const row=await this.repository.connection(use.ownerId,binding.connectionId)
    const client=this.worker(this.repository.scope(row)).forUse(use)
    await client.call('prepare',{revision:authorized.binding.connectionRevision},signal)
    const info=await client.call<{accountId:string;plan?:string;expiresAt:string}>('nativeContext',{revision:authorized.binding.connectionRevision},signal)
    return nativeBrokerContextSchema.parse({...info,route:binding.route,modelId:binding.modelId,revision:authorized.binding.connectionRevision})
  }
  /** A device run's access lease: the same checks as nativeContext, then the access token only. */
  async nativeLease(use: SubscriptionUse, signal?: AbortSignal) {
    const context=await this.nativeContext(use,signal)
    const binding=await this.repository.binding(use.ownerId,use.bindingId)
    const row=await this.repository.connection(use.ownerId,binding.connectionId)
    const lease=await this.worker(this.repository.scope(row)).forUse(use).call<{accessToken?:unknown;expiresAt?:unknown}>('nativeAuth',{revision:context.revision},signal)
    return nativeLeaseSchema.parse({...context,accessToken:lease.accessToken,...(typeof lease.expiresAt==='string'?{expiresAt:new Date(lease.expiresAt).toISOString()}:{})})
  }
  async nativeRequest(use: SubscriptionUse, request: NativeBrokerRequest, signal?: AbortSignal) {
    const binding=await this.repository.binding(use.ownerId,use.bindingId)
    if(!request.body || typeof request.body!=='object' || Array.isArray(request.body) || !('model' in request.body) || typeof request.body.model!=='string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.body.model))throw new SubscriptionRefusal('binding_mismatch')
    const selectedModel = await this.nativeSelectedModel(use, binding.modelId)
    if (selectedModel !== undefined && request.body.model!==selectedModel) throw new SubscriptionRefusal('binding_mismatch')
    if(binding.route==='codex_cli'?request.path!=='/responses':binding.route!=='claude_code_cli'||!['/v1/messages','/v1/messages?beta=true'].includes(request.path))throw new SubscriptionRefusal('backend_unavailable')
    await this.admitModel({ ownerId: use.ownerId, workspaceId: binding.workspaceId, runId: use.runId }, request.body.model, binding.route, signal)
    const authorized=await this.check(use,signal)
    await this.admitModel({ ownerId: use.ownerId, workspaceId: binding.workspaceId, runId: use.runId }, request.body.model, binding.route, signal)
    const row=await this.repository.connection(use.ownerId,binding.connectionId)
    return this.worker(this.repository.scope(row)).forUse(use).nativeRequest(authorized.binding.connectionRevision,request,signal)
  }
  private async nativeSelectedModel(use: SubscriptionUse, boundModel: string) {
    let selectedModel: string | undefined = boundModel
    if (use.runId) {
      const row=(await this.repository.pool.query(`SELECT r."agentDefinition" FROM agent_runs r JOIN byos_native_runs n ON n."runId"=r.id WHERE r.id=$1 AND r."userId"=$2 AND r."agentId"::text=$3 AND n."bindingId"=$4 AND r.status IN ('preparing','running','paused','waiting_input') AND r."leaseExpiresAt">now() AND r."stopRequestedAt" IS NULL`,[use.runId,use.ownerId,use.consumerId,use.bindingId])).rows[0]
      if (!row) throw new SubscriptionRefusal('binding_mismatch')
      if (row.agentDefinition?.cliModelSelection==='auto') selectedModel=undefined
      if (row.agentDefinition?.cliModelSelection==='explicit') selectedModel=row.agentDefinition.model
    }
    return selectedModel
  }
  async launchNative<T>(ownerId: string, consumerId: string, bindingId: string, run: (context: { use: SubscriptionUse; modelId: string; worker: Pick<SubscriptionWorkerClient, 'call'>; access(): Promise<SubscriptionAccess> }) => Promise<T>) {
    const binding = await this.repository.binding(ownerId, bindingId)
    // This legacy in-process launcher hands credentials to its adapter. It is
    // not the task-bound HTTP broker and cannot claim controlled model routing.
    const { assertUnmanagedModelTransport } = await import('./model-admission/runtime')
    await assertUnmanagedModelTransport({ ownerId, workspaceId: binding.workspaceId }, binding.modelId)
    const use: SubscriptionUse = { ownerId, consumerId, bindingId, workspaceId: binding.workspaceId, execution: 'native' }
    await this.check(use)
    const row = await this.repository.connection(ownerId, binding.connectionId)
    return run({ use, modelId: binding.modelId, access: () => this.access(use), worker: this.worker(this.repository.scope(row)).forUse(use) })
  }
  /** The owner's own Settings read: no binding, a connected revision only.
   * Never throws for a provider or worker failure: the row degrades instead,
   * keeping the last known email. */
  async usage(ownerId: string, id: string, signal?: AbortSignal): Promise<SubscriptionUsage> {
    const row = await this.repository.connection(ownerId, id)
    if (row.state !== 'connected') return failedUsage(row.id, 'unavailable', row.accountLabel)
    try {
      const result = await this.worker(this.repository.scope(row)).call<WorkerUsage>('usage', { revision: Number(row.epoch) }, signal)
      const usage = parseSubscriptionUsage(row.id, row.provider, result)
      if (usage.account && usage.account !== row.accountLabel) await this.repository.saveAccountLabel(row, usage.account).catch(() => undefined)
      return { ...usage, account: usage.account ?? accountLabel(row.accountLabel) }
    } catch {
      // The list shows a connection the runtime itself moved to reconnect_required.
      return failedUsage(row.id, 'unavailable', row.accountLabel)
    }
  }
  /** Account catalogue refresh; no inference, no static model names or binding required. */
  async models(ownerId: string, id: string, signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
    // The owner's own account-level read: no workspace membership needed (decision 2026-10-31-2130).
    const row = await this.repository.connection(ownerId, id)
    if (row.state !== 'connected') throw new SubscriptionRefusal('account_unavailable')
    const result = await this.worker(this.repository.scope(row)).call<unknown>('models', { revision: Number(row.epoch) }, signal)
    const current = await this.repository.connection(ownerId, id)
    if (current.state !== 'connected' || current.epoch !== row.epoch) throw new SubscriptionRefusal('stale_binding')
    if (!Array.isArray(result) || result.length > 500) throw new SubscriptionRefusal('backend_unavailable')
    const options = new Map<string, { id: string; name: string }>()
    for (const item of result) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || Array.from(item.name as string).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new SubscriptionRefusal('backend_unavailable')
      if (!options.has(item.id)) options.set(item.id, { id: item.id, name: item.name })
    }
    return [...options.values()]
  }
  async status(ownerId: string, id: string, signal?: AbortSignal) {
    const row = await this.repository.connection(ownerId, id)
    const status = await this.worker(this.repository.scope(row)).call<WorkerMetadata>('status', {}, signal)
    return { id: row.id, provider: row.provider, state: status.state, revision: status.revision, cleanup: status.cleanup }
  }
  async cleanupBatch() {
    // Operator-authenticated caller only. Each worker remains fixed to one
    // owner/connection; this never lists or exports credential values.
    const { rows } = await this.repository.pool.query(`with due as(select a."connectionId",a."deletingAt" as attempted from byos_secret_artifacts a join byos_connections c on c.id=a."connectionId" where a."deletedAt" is null and (a."publishedAt" is not null or a."notBefore"<=now()) and a.name not in (coalesce(c."secretName",''),coalesce(c."accessSecretName",''),coalesce(c."stagedSecretName",''),coalesce(c."stagedAccessName",'')) union all select a."connectionId",a."lastAttemptAt" from byos_enrollment_sources a join byos_enrollment_transfers t on t."enrollmentId"=a."enrollmentId" join byos_connections c on c.id=a."connectionId" where a."deletedAt" is null and (t."canonicalPublishedAt" is not null or t."boundAt" is not null or c.epoch>t.epoch)) select c.id,c."ownerId",c."workspaceId",c.provider from due d join byos_connections c on c.id=d."connectionId" group by c.id,c."ownerId",c."workspaceId",c.provider order by coalesce(max(d.attempted),'epoch'::timestamptz),c.id limit 2`)
    const results = []
    for (const row of rows) {
      try { results.push(await this.worker(this.repository.scope(row)).call<{pending: number; failed: number; providerRevocation: 'not_implemented'}>('cleanup')) }
      catch { results.push({ pending: null, failed: true }) }
    }
    return { processed: results.length, results }
  }
}
