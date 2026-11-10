import { captureRunFailure, type RunFailureContext } from '@mikka/protocol/run-failure'
import { WorkflowRunFailureError } from './workflow-run-failure'
import { APP_BUILD } from './app-build'
import { workerSubscriptionMatches } from './agent-kit/worker'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { quotaSnapshotSchema, type QuotaSnapshot } from '@mikka/protocol'
import { authorizeSubscriptionUse, subscriptionQuotaState, SubscriptionRefusal, type SubscriptionAccess, type SubscriptionRoute, type SubscriptionUse } from '@mikka/protocol/subscription'
import { WorkerRefusal, type SubscriptionWorkerClient, type WorkerMetadata } from '../packages/daemon/src/subscription-worker-client'
import { readSubscriptionQuota } from '../packages/daemon/src/subscription-quota'
import { SubscriptionRepository } from './subscription-repository'
import { runMayUseCredentialSql } from './personal-policy'
import { resolveSubscriptionModel } from './subscription-model'
import { nativeBrokerContextSchema, nativeLeaseSchema, type NativeBrokerRequest } from '@mikka/protocol/subscription'
import { accountLabel, failedUsage, parseSubscriptionUsage, type SubscriptionUsage, type WorkerUsage } from './subscription-usage'
import { BACKEND_FAILURES, GENERATION_FAILURES, PRIVATE_FAILURES, generationFailureDetails } from './subscription-generation-diagnostics'
import { stepIdentity } from './model-call-timing'
import { CLEANUP_DUE_SQL, expireSubscriptionAcquisitions } from './subscription-acquire-expiry'
import { ownerSettingsChanged } from './live/lists'
import { measureSubscriptionNative } from './subscription-native-timing'
import { codexPrioritySupport, subscriptionModelRequestPolicySchema, type CodexPrioritySupport, type SubscriptionCatalogueModel, type SubscriptionModelRequestPolicy } from './subscription-service-tier'

// Matches modelRequestMaxBytes in the Go worker. The conversation's 100k
// compaction estimate excludes the system prompt and tool schemas.
const MODEL_REQUEST_MAX_BYTES = 1_048_576
// Used only to preserve the public refusal of inputs still over budget.
const LEGACY_HOST_CODE_UNIT_LIMIT = 262144

export interface SubscriptionCapabilities {
  /** Whether the route runs for this subscription owner (lib/subscription-routes.ts). */
  ready(route: SubscriptionRoute, ownerId: string): boolean | Promise<boolean>
  nativeIsolation: 'verified_runtime' | 'none'
  oauth?: Partial<Record<'codex' | 'claude', boolean>>
}

export class SubscriptionService {
  private readonly modelRequestPolicy?: SubscriptionModelRequestPolicy
  constructor(readonly repository: SubscriptionRepository,
    readonly worker: (scope: ReturnType<SubscriptionRepository['scope']>) => SubscriptionWorkerClient,
    readonly capabilities: SubscriptionCapabilities,
    readonly quota: (provider: 'codex' | 'claude', result: {status: number; body: unknown}) => Promise<QuotaSnapshot> | QuotaSnapshot = readSubscriptionQuota,
    readonly workspace: (ownerId: string, workspaceId: string, consumerId?: string) => Promise<void> = async () => { throw new SubscriptionRefusal('account_unavailable') },
    readonly admitModel: (scope: { ownerId: string; workspaceId: string; runId?: string }, model: string, route: string, signal?: AbortSignal, auditAllowed?: boolean) => Promise<void> = async (...args) => {
      const { assertSubscriptionModelTransport } = await import('./model-admission/runtime')
      await assertSubscriptionModelTransport(...args)
    },
    /** Active membership in the workspace database; a teammate's shared subscription needs it for both people. */
    readonly member: (userId: string, workspaceId: string, borrowerId?: string) => Promise<void> = async () => { throw new SubscriptionRefusal('account_unavailable') },
    modelRequestPolicy?: SubscriptionModelRequestPolicy) {
    this.modelRequestPolicy = modelRequestPolicy === undefined ? undefined : subscriptionModelRequestPolicySchema.parse(modelRequestPolicy)
  }

  async access(use: SubscriptionUse, signal?: AbortSignal, modelOverride?: string | null, includePrioritySupport = false): Promise<SubscriptionAccess & { codexPrioritySupport?: CodexPrioritySupport }> {
    const { modelId: boundModelId, ...binding } = await this.repository.binding(use.ownerId, use.bindingId)
    if (binding.workspaceId !== use.workspaceId || binding.consumerId !== use.consumerId) throw new SubscriptionRefusal('binding_mismatch')
    await this.workspace(use.ownerId, binding.workspaceId, binding.consumerId)
    const row = await this.repository.connection(use.ownerId, binding.connectionId)
    if (row.paused) throw new SubscriptionRefusal('account_unavailable')
    const revision = Number(row.epoch)
    const readiness = (await this.capabilities.ready(binding.route, use.ownerId)) ? 'ready' : 'unavailable'
    const baseQuota = { vendor: row.provider === 'codex' ? 'codex' : 'claude_code', status: 'unknown', source: 'local_credentials', plan: null, observedAt: new Date().toISOString(), windows: [] }
    let quota = quotaSnapshotSchema.safeParse(row.quota).data ?? quotaSnapshotSchema.parse(baseQuota)
    // Probe only after scope/state/revision and server-side capability checks.
    if ((use.execution !== 'native' || this.capabilities.nativeIsolation === 'verified_runtime') && readiness === 'ready' && row.state === 'connected' && revision === binding.connectionRevision && (subscriptionQuotaState(quota, binding.route, Date.now(), modelOverride === null ? undefined : modelOverride ?? boundModelId) === 'unknown' || Date.now() - Date.parse(quota.observedAt) > 45_000)) {
      const client = this.worker(this.repository.scope(row)).forUse(use)
      await client.call('prepare', { revision }, signal)
      const result = await client.call<{status: number; body: unknown}>('quota', { revision }, signal)
      quota = quotaSnapshotSchema.parse(await this.quota(row.provider, result))
      await this.repository.saveQuota(row, quota)
    }
    // Re-read after async quota probing: disconnect/reconnect must win.
    const current = await this.repository.connection(use.ownerId, row.id)
    if (current.paused) throw new SubscriptionRefusal('account_unavailable')
    return {
      binding,
      ...(includePrioritySupport ? { codexPrioritySupport: current.provider === 'codex' ? codexPrioritySupport(current.modelCatalog, Number(current.epoch), modelOverride ?? boundModelId) : 'unknown' as const } : {}),
      modelId: modelOverride === null ? undefined : modelOverride ?? boundModelId,
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
    return resolveSubscriptionModel(use, binding.modelId, {
      access: () => this.access(use, signal),
      model: async (modelId, { connection }) => {
        // This call's access check already read and verified the custody scope.
        // Each later model/HTTP call still runs its own fresh authorization.
        const client = this.worker({ ownerId: connection.ownerId, workspaceId: connection.workspaceId, connectionId: connection.id, provider: connection.provider === 'openai' ? 'codex' : 'claude' }).forUse(use)
        const provider = createOpenAICompatible({ name: 'mikka-subscription', baseURL: 'https://mikka.invalid/v1', apiKey: 'private-worker-placeholder',
          fetch: async (_url, init) => {
            if (typeof init?.body !== 'string') {
              await logRequestFailure('body_invalid', null)
              throw new SubscriptionRefusal('backend_unavailable')
            }
            const bytes = Buffer.byteLength(init.body, 'utf8')
            if (bytes > MODEL_REQUEST_MAX_BYTES) {
              await logRequestFailure('payload_too_large', bytes)
              // Keep the old public mapping; the UTF-16 threshold is not the
              // new transport budget and does not decide whether to admit it.
              throw init.body.length > LEGACY_HOST_CODE_UNIT_LIMIT
                ? new SubscriptionRefusal('backend_unavailable')
                : new Error('subscription_generation_failed')
            }
            const payload = JSON.parse(init.body)
            if (payload.model !== binding.modelId || payload.stream !== true) throw new SubscriptionRefusal('binding_mismatch')
            const priorityRequested = binding.route === 'codex_cpa' && this.modelRequestPolicy?.codexServiceTier === 'priority'
            const authorized = await this.check(use, signal, undefined, priorityRequested)
            await admit(init.signal ?? signal ?? undefined)
            // Provider options are not an opt-in to a paid service tier. Only
            // the internal Coordinator policy and this fresh epoch's catalogue
            // can request it. Unknown/unsupported uses the same single call.
            if (binding.route === 'codex_cpa') {
              delete payload.service_tier
              if (priorityRequested && authorized.codexPrioritySupport === 'supported') payload.service_tier = 'priority'
              if (priorityRequested) {
                try { console.info(JSON.stringify({ level: 'info', msg: 'subscription_service_tier_policy', intent: 'priority', capability: authorized.codexPrioritySupport ?? 'unknown', requested: payload.service_tier === 'priority' ? 'priority' : 'omitted', ...await stepIdentity() })) } catch { /* diagnostics cannot change authorization or the request */ }
              }
            }
            return new Response(client.stream(binding.connectionRevision, modelId, payload, init.signal ?? signal ?? undefined), { headers: { 'content-type': 'text/event-stream' } })
          }
        })
        const model = provider(modelId)
        const doStream = model.doStream.bind(model)
        model.doStream = async options => {
          const failureContext: RunFailureContext = { credential: 'subscription', provider: connection.provider === 'openai' ? 'codex' : 'claude_code', appVersion: APP_BUILD, requestBodyValues: { prompt: options.prompt, tools: options.tools, providerOptions: options.providerOptions, headers: options.headers } }
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
                  if (value.type === 'error') {
                    const cancelled = requestedCancellation(value.error, options.abortSignal, signal)
                    if (cancelled) {
                      closed = true; controller.error(cancelled)
                      try { await reader.cancel(cancelled) } finally { reader.releaseLock() }
                      return
                    }
                    await logGenerationFailure('stream_part', value.error)
                  }
                  controller.enqueue(value.type === 'error' ? { type: 'error', error: subscriptionGenerationError(value.error, failureContext) } : value)
                } catch (error) {
                  if (closed) return
                  const cancelled = requestedCancellation(error, options.abortSignal, signal)
                  if (cancelled) { closed = true; reader.releaseLock(); controller.error(cancelled); return }
                  await logGenerationFailure('stream', error)
                  closed = true; reader.releaseLock()
                  controller.enqueue({ type: 'error', error: subscriptionGenerationError(error, failureContext) }); controller.close()
                }
              },
              async cancel(reason) { closed = true; await reader.cancel(reason); reader.releaseLock() }
            })
            return { ...result, stream }
          } catch (error) {
            const cancelled = requestedCancellation(error, options.abortSignal, signal)
            if (cancelled) throw cancelled
            await logGenerationFailure('start', error); throw subscriptionGenerationError(error, failureContext)
          }
        }
        return model
      }
    })
  }
  async check(use: SubscriptionUse, signal?: AbortSignal, modelOverride?: string | null, includePrioritySupport = false) {
    const access = await this.access(use, signal, modelOverride, includePrioritySupport)
    const authorized = authorizeSubscriptionUse(use, access)
    return { ...authorized, ...(includePrioritySupport ? { codexPrioritySupport: access.codexPrioritySupport } : {}) }
  }
  async nativeRun(ownerId: string, deviceId: string, runId: string) {
    const { rows } = await this.repository.pool.query(`select b.id,b."ownerId",b."workspaceId",b."consumerId",b.route,b."modelId",r."agentDefinition",a.harness from byos_native_runs n join agent_runs r on r.id=n."runId" join agents a on a.id=r."agentId" join devices d on d.id=r."deviceId" and d."ownerId"=r."userId" and d.enabled=true join byos_bindings b on b.id=n."bindingId" where r.id=$1 and r."userId"=$2 and r."deviceId"=$3 and a."userId"=$2 and ${runMayUseCredentialSql('b."ownerId"', '$2', 'b."workspaceId"')} and b."consumerId"=a.id::text and d.harnesses @> jsonb_build_array(jsonb_build_object('harness',coalesce(r."agentDefinition"->>'harness',a.harness),'installed',true,'subscriptionBroker',true))
      and not exists (select 1 from jsonb_array_elements(d.harnesses) info where info->>'harness'=coalesce(r."agentDefinition"->>'harness',a.harness) and info ? 'subscriptionPreflight')
      and r.status in ('preparing','running','paused','waiting_input') and r."leaseExpiresAt">now() and r."stopRequestedAt" is null`, [runId,ownerId,deviceId])
    if (!rows[0]) throw new SubscriptionRefusal('account_unavailable')
    const row=rows[0]
    if (!workerSubscriptionMatches(row.agentDefinition,row.harness,row)) throw new SubscriptionRefusal('binding_mismatch')
    if (String(row.ownerId) !== ownerId) {
      try { await this.member(ownerId, row.workspaceId); await this.member(String(row.ownerId), row.workspaceId, ownerId) }
      catch { throw new SubscriptionRefusal('account_unavailable') }
    }
    // The use belongs to the credential's owner: the run owner, or the member who shared it (分享给团队成员).
    return {ownerId:String(row.ownerId),workspaceId:row.workspaceId,consumerId:row.consumerId,bindingId:row.id,execution:'native',runId} as const
  }
  async nativeContext(use: SubscriptionUse, signal?: AbortSignal, requireModelCatalogue = false) {
    return measureSubscriptionNative('context', use.runId, async timing => {
      const binding=await timing.measure('binding', () => this.repository.binding(use.ownerId,use.bindingId))
      const selected = await timing.measure('selection', () => this.nativeRunSelection(use, binding.modelId))
      const scope = { ownerId: selected.executionOwnerId, workspaceId: binding.workspaceId, runId: use.runId }
      // Context probes enforce policy without recording a model generation.
      await timing.measure('admit_before', () => this.admitModel(scope, selected.modelId ?? binding.modelId, binding.route, signal, false))
      const authorized=await timing.measure('access', () => this.check(use,signal,selected.modelId ?? null))
      await timing.measure('admit_after', () => this.admitModel(scope, selected.modelId ?? binding.modelId, binding.route, signal, false))
      const row=await timing.measure('connection', () => this.repository.connection(use.ownerId,binding.connectionId))
      // Requested only by a daemon that could not resolve a full ID through its
      // shortcut menu. The evidence belongs to this exact authorized binding and
      // credential epoch; a different account's catalogue grants nothing.
      if (requireModelCatalogue && (binding.route !== 'claude_code_cli' || row.state !== 'connected'
        || row.paused || Number(row.epoch) !== authorized.binding.connectionRevision
        || !row.modelCatalog || Number(row.modelCatalog.revision) !== Number(row.epoch)
        || !Array.isArray(row.modelCatalog.models) || !row.modelCatalog.models.includes(binding.modelId))) {
        throw new SubscriptionRefusal('binding_mismatch')
      }
      const client=this.worker(this.repository.scope(row)).forUse(use)
      await timing.measure('prepare', () => client.call('prepare',{revision:authorized.binding.connectionRevision},signal))
      const info=await timing.measure('context', () => client.call<{accountId:string;plan?:string;expiresAt:string}>('nativeContext',{revision:authorized.binding.connectionRevision},signal))
      return nativeBrokerContextSchema.parse({...info,route:binding.route,modelId:binding.modelId,revision:authorized.binding.connectionRevision})
    })
  }
  /** Prepare a device's direct-provider credential once. nativeAuth performs
   * the custody refresh itself and returns the expiry with the access token;
   * separate prepare/context child processes would repeat that same work. */
  async nativeLease(use: SubscriptionUse, signal?: AbortSignal, includeModelCatalogue = false) {
    return measureSubscriptionNative('lease', use.runId, async timing => {
      const binding = await timing.measure('binding', () => this.repository.binding(use.ownerId, use.bindingId))
      const selected = await timing.measure('selection', () => this.nativeRunSelection(use, binding.modelId))
      const model = selected.modelId ?? binding.modelId
      const scope = { ownerId: selected.executionOwnerId, workspaceId: binding.workspaceId, runId: use.runId }
      await timing.measure('admit_before', () => this.admitModel(scope, model, binding.route, signal, false))
      const authorized = await timing.measure('access', () => this.check(use, signal, model ?? null))
      await timing.measure('admit_after', () => this.admitModel(scope, model, binding.route, signal, false))
      const row = await timing.measure('connection', () => this.repository.connection(use.ownerId, binding.connectionId))
      // This is evidence for the prepared model, not another authorization
      // round trip. Reuse the exact connection/epoch already read for custody.
      // Older strict lease clients retain their original response shape.
      const catalogue = row.modelCatalog
      const modelCatalogueVerified = includeModelCatalogue && binding.route === 'claude_code_cli'
        && row.id === binding.connectionId && String(row.ownerId) === use.ownerId
        && row.state === 'connected' && !row.paused
        && Number(row.epoch) === authorized.binding.connectionRevision
        && catalogue != null && Number(catalogue.revision) === Number(row.epoch)
        && Array.isArray(catalogue.models) && catalogue.models.includes(model)
      const lease = await timing.measure('native_auth', () => this.worker(this.repository.scope(row)).forUse(use)
        .call<{ accessToken?: unknown; expiresAt?: unknown; accountId?: unknown; chatgptAccountId?: unknown; chatgptPlanType?: unknown }>('nativeAuth', { revision: authorized.binding.connectionRevision }, signal))
      return nativeLeaseSchema.parse({ route: binding.route, modelId: model, revision: authorized.binding.connectionRevision,
        ...(modelCatalogueVerified ? { modelCatalogueVerified: true } : {}),
        accountId: binding.route === 'codex_cli' ? lease.chatgptAccountId : lease.accountId,
        ...(typeof lease.chatgptPlanType === 'string' ? { plan: lease.chatgptPlanType } : {}),
        accessToken: lease.accessToken, expiresAt: typeof lease.expiresAt === 'string' ? new Date(lease.expiresAt).toISOString() : lease.expiresAt })
    })
  }
  async nativeRequest(use: SubscriptionUse, request: NativeBrokerRequest, signal?: AbortSignal) {
    return measureSubscriptionNative('request', use.runId, async timing => {
      const binding=await timing.measure('binding', () => this.repository.binding(use.ownerId,use.bindingId))
      if(!request.body || typeof request.body!=='object' || Array.isArray(request.body) || !('model' in request.body) || typeof request.body.model!=='string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.body.model))throw new SubscriptionRefusal('binding_mismatch')
      const selected = await timing.measure('selection', () => this.nativeRunSelection(use, binding.modelId))
      if (selected.modelId !== undefined && request.body.model!==selected.modelId) throw new SubscriptionRefusal('binding_mismatch')
      if(binding.route==='codex_cli'?request.path!=='/responses':binding.route!=='claude_code_cli'||!['/v1/messages','/v1/messages?beta=true'].includes(request.path))throw new SubscriptionRefusal('backend_unavailable')
      const scope = { ownerId: selected.executionOwnerId, workspaceId: binding.workspaceId, runId: use.runId }
      const model = request.body.model
      await timing.measure('admit_before', () => this.admitModel(scope, model, binding.route, signal))
      const authorized=await timing.measure('access', () => this.check(use,signal,model))
      await timing.measure('admit_after', () => this.admitModel(scope, model, binding.route, signal))
      const row=await timing.measure('connection', () => this.repository.connection(use.ownerId,binding.connectionId))
      return timing.measure('provider_headers', () => this.worker(this.repository.scope(row)).forUse(use).nativeRequest(authorized.binding.connectionRevision,request,signal))
    })
  }
  /** Run policy belongs to the executor; credential custody stays with its
   * lender. Both identities come from the authorized binding/run, never input. */
  private async nativeRunSelection(use: SubscriptionUse, boundModel: string) {
    let selectedModel: string | undefined = boundModel
    let executionOwnerId = use.ownerId
    if (use.runId) {
      const row=(await this.repository.pool.query(`SELECT r."userId",r."agentDefinition" FROM agent_runs r JOIN byos_native_runs n ON n."runId"=r.id JOIN byos_bindings b ON b.id=n."bindingId" WHERE r.id=$1 AND b."ownerId"=$2 AND ${runMayUseCredentialSql('$2', 'r."userId"', 'b."workspaceId"')} AND r."agentId"::text=$3 AND n."bindingId"=$4 AND r.status IN ('preparing','running','paused','waiting_input') AND r."leaseExpiresAt">now() AND r."stopRequestedAt" IS NULL`,[use.runId,use.ownerId,use.consumerId,use.bindingId])).rows[0]
      if (!row || typeof row.userId !== 'string' || !row.userId) throw new SubscriptionRefusal('binding_mismatch')
      executionOwnerId = row.userId
      if (executionOwnerId !== use.ownerId) await this.member(use.ownerId, use.workspaceId, executionOwnerId)
      if (row.agentDefinition?.cliModelSelection==='auto') selectedModel=undefined
      if (row.agentDefinition?.cliModelSelection==='explicit') selectedModel=row.agentDefinition.model
    }
    return { modelId: selectedModel, executionOwnerId }
  }
  /**
   * In-process native launch, used only by the BYOS custody test
   * (tests/byos-application.test.mjs) to drive synthetic CLIs through
   * disconnect and reconnect. No production path calls it: a device run gets
   * native credentials through `nativeRun`, which needs a runId and checks
   * `runMayUseCredentialSql` and membership on both sides.
   */
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
  /** Fresh allowance for model admission, under the same owner custody as Usage.
   * Settings-only account/profile reads and account writes stay in usage(). */
  async allowance(ownerId: string, id: string, signal?: AbortSignal): Promise<void> {
    const row = await this.repository.connection(ownerId, id)
    if (row.state !== 'connected') return
    try {
      const result = await this.worker(this.repository.scope(row)).call<Pick<WorkerUsage, 'status' | 'body'>>('allowance', { revision: Number(row.epoch) }, signal)
      const quota = quotaSnapshotSchema.parse(await this.quota(row.provider, result))
      const plan = result.body && typeof result.body === 'object' && 'plan_type' in result.body ? result.body.plan_type : undefined
      // Only the already-returned, allowlisted Codex quota plan is new metadata.
      // Claude and missing/unknown plans keep the current DB value in the same
      // epoch-fenced UPDATE, including a Settings change during this await.
      const hasPlan = row.provider === 'codex' && result.status === 200 && typeof plan === 'string'
        && ['plus', 'pro', 'free', 'team', 'business', 'enterprise', 'go'].includes(plan) && typeof quota.plan === 'string' && quota.plan.length > 0
      await this.repository.saveQuota(row, quota, hasPlan ? undefined : { preservePlan: true })
    } catch {
      const now = await this.repository.connection(ownerId, id).catch(() => null)
      if (now && now.state !== row.state) await (await import('./live/lists')).ownerSettingsChanged(this.repository.pool, ownerId)
    }
  }
  /** The owner's own Settings read: no binding, a connected revision only.
   * Never throws for a provider or worker failure: the row degrades instead,
   * keeping the last known email. */
  async usage(ownerId: string, id: string, signal?: AbortSignal): Promise<SubscriptionUsage> {
    const row = await this.repository.connection(ownerId, id)
    if (row.state !== 'connected') return failedUsage(row.id, 'unavailable', row.accountLabel)
    try {
      const result = await this.worker(this.repository.scope(row)).call<WorkerUsage>('usage', { revision: Number(row.epoch) }, signal)
      // The same safe provider projection drives Settings and the next Bot/Agent
      // use. saveQuota fences the read to this owner and connected revision.
      await this.repository.saveQuota(row, quotaSnapshotSchema.parse(await this.quota(row.provider, result)))
      const usage = parseSubscriptionUsage(row.id, row.provider, result)
      if (usage.account && usage.account !== row.accountLabel) await this.repository.saveAccountLabel(row, usage.account).catch(() => undefined)
      return { ...usage, account: usage.account ?? accountLabel(row.accountLabel) }
    } catch {
      // The list shows a connection the runtime itself moved to reconnect_required; open 模型与订阅 pages re-read it.
      const now = await this.repository.connection(ownerId, id).catch(() => null)
      if (now && now.state !== row.state) await (await import('./live/lists')).ownerSettingsChanged(this.repository.pool, ownerId)
      return failedUsage(row.id, 'unavailable', row.accountLabel)
    }
  }
  /** Account catalogue refresh; no inference, no static model names or binding required. */
  async models(ownerId: string, id: string, signal?: AbortSignal): Promise<(SubscriptionCatalogueModel & { name: string })[]> {
    // The owner's own account-level read: no workspace membership needed (decision 2026-10-31-2130).
    const row = await this.repository.connection(ownerId, id)
    if (row.state !== 'connected') throw new SubscriptionRefusal('account_unavailable')
    const result = await this.worker(this.repository.scope(row)).call<unknown>('models', { revision: Number(row.epoch) }, signal)
    const current = await this.repository.connection(ownerId, id)
    if (current.state !== 'connected' || current.epoch !== row.epoch) throw new SubscriptionRefusal('stale_binding')
    if (!Array.isArray(result) || result.length > 500) throw new SubscriptionRefusal('backend_unavailable')
    const options = new Map<string, SubscriptionCatalogueModel & { name: string }>()
    for (const item of result) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || Array.from(item.name as string).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new SubscriptionRefusal('backend_unavailable')
      if (item.prioritySupported !== undefined && typeof item.prioritySupported !== 'boolean') throw new SubscriptionRefusal('backend_unavailable')
      if (!options.has(item.id)) options.set(item.id, { id: item.id, name: item.name, ...(row.provider === 'codex' && typeof item.prioritySupported === 'boolean' ? { prioritySupported: item.prioritySupported } : {}) })
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
    const expired = await expireSubscriptionAcquisitions(this.repository.pool)
    await Promise.all(expired.ownerIds.map(ownerId => ownerSettingsChanged(this.repository.pool, ownerId)))
    const { rows } = await this.repository.pool.query(`with due as(${CLEANUP_DUE_SQL}) select c.id,c."ownerId",c."workspaceId",c.provider from due d join byos_connections c on c.id=d."connectionId" group by c.id,c."ownerId",c."workspaceId",c.provider order by coalesce(max(d.attempted),'epoch'::timestamptz),c.id limit 2`)
    const results = []
    for (const row of rows) {
      try { results.push(await this.worker(this.repository.scope(row)).call<{pending: number; failed: number; providerRevocation: 'not_implemented'}>('cleanup')) }
      catch { results.push({ pending: null, failed: true }) }
    }
    return { expired: expired.expired, processed: results.length, results }
  }
}

/** The SDK recognizes a requested cancellation by AbortError, not an error
 * part. Preserve that control flow through its HTTP wrapper; an ordinary
 * provider error, unrequested cancellation, or deadline is still a failure. */
function requestedCancellation(error: unknown, ...signals: (AbortSignal | undefined)[]): Error | undefined {
  if (!signals.some(signal => signal?.aborted && !(signal.reason instanceof Error && signal.reason.name === 'TimeoutError'))) return
  let cause = error
  for (let depth = 0; depth < 4; depth++) {
    if ((cause instanceof WorkerRefusal && cause.code === 'subscription_cancelled') || (cause instanceof Error && cause.name === 'AbortError')) {
      return Object.assign(new Error('subscription_cancelled', { cause: error }), { name: 'AbortError' })
    }
    if (!(cause instanceof Error)) break
    cause = cause.cause
  }
}

/** Only fixed, typed refusal codes cross into persisted chat errors. SDK
 * wrappers may carry the original error in cause; raw provider text cannot. */
export function subscriptionGenerationError(error: unknown, context: RunFailureContext = {}): Error {
  const original = error
  let code = 'subscription_generation_failed'
  for (let depth = 0; depth < 4; depth++) {
    if (error instanceof SubscriptionRefusal || error instanceof WorkerRefusal) {
      if (GENERATION_FAILURES.has(error.code)) { code = error.code; break }
      if (error.code === 'invalid_credential_bundle') { code = 'reconnect_required'; break }
      if (BACKEND_FAILURES.has(error.code)) { code = 'backend_unavailable'; break }
    }
    if (!(error instanceof Error)) break
    error = error.cause
  }
  return new WorkflowRunFailureError(captureRunFailure(original, { credential: 'subscription', ...context }), { cause: original }, code)
}

/**
 * Why a subscription turn produced no answer, for the logs: the stage and the
 * fixed refusal code (SubscriptionRefusal, WorkerRefusal) or the error's class
 * name. Never a message, which can carry provider text.
 */
export function generationFailureCode(error: unknown): string {
  if ((error instanceof SubscriptionRefusal || error instanceof WorkerRefusal) && (GENERATION_FAILURES.has(error.code) || BACKEND_FAILURES.has(error.code) || PRIVATE_FAILURES.has(error.code))) return error.code
  return generationFailureDetails(error).errorClass
}
async function logGenerationFailure(stage: 'start' | 'stream' | 'stream_part', error: unknown) {
  try {
    const identity = await stepIdentity()
    console.warn(JSON.stringify({ level: 'warn', msg: 'subscription_generation_failed', stage, code: generationFailureCode(error), ...generationFailureDetails(error), workflowRunId: identity.workflowRunId ?? null, stepId: identity.stepId ?? null, attempt: identity.attempt ?? null }))
  } catch { /* diagnostics cannot change the model result */ }
}

async function logRequestFailure(reason: 'body_invalid' | 'payload_too_large', bytes: number | null) {
  try {
    const identity = await stepIdentity()
    console.warn(JSON.stringify({ level: 'warn', msg: 'subscription_request_failure', phase: 'host_input', reason, bytes, limit: MODEL_REQUEST_MAX_BYTES, workflowRunId: identity.workflowRunId ?? null, stepId: identity.stepId ?? null, attempt: identity.attempt ?? null }))
  } catch { /* diagnostics cannot change the model result */ }
}
