import type { LanguageModel } from 'ai'
import { z } from 'zod'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { agentModelSourceSchema } from './agent-model'
import { resolveAgentExecutionModel } from './agent-execution-model'
import type { SubscriptionService } from './subscription-service'

export const hostedSubscriptionSnapshotSchema = z.strictObject({
  type: z.literal('subscription'), bindingId: z.uuid(), ownerId: z.string().min(1),
  consumerId: z.uuid(), workspaceId: z.uuid(), connectionId: z.uuid(),
  connectionRevision: z.number().int().positive(), modelId: z.string().min(1).max(128),
  route: z.enum(['codex_cpa', 'claude_cpa', 'openai_siwc']),
})
export type HostedSubscriptionSnapshot = z.infer<typeof hostedSubscriptionSnapshotSchema>
export interface HostedRuntimeSnapshot {
  harness: string
  model: string | null
  modelSelection?: HostedSubscriptionSnapshot
}
export interface HostedModelScope { ownerId: string; botId: string | null; workspaceId: string | null }
export interface HostedModelDependencies {
  service(): SubscriptionService
  workspace(ownerId: string, workspaceId: string): Promise<void>
}
const refuse = () => new SubscriptionRefusal('binding_mismatch')
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Model resolution cancelled', 'AbortError')
}
function checkScope(scope: HostedModelScope, value: HostedSubscriptionSnapshot) {
  if (scope.ownerId !== value.ownerId || scope.botId !== value.consumerId || scope.workspaceId !== value.workspaceId) throw refuse()
}
/** Called only inside first execution reservation, never before replay lookup. */
export async function freezeHostedModelSelection(scope: HostedModelScope, runtime: HostedRuntimeSnapshot, selection: unknown, dependencies: HostedModelDependencies): Promise<HostedRuntimeSnapshot> {
  if (selection === undefined) return { harness: runtime.harness, model: runtime.model }
  if (runtime.harness !== 'ai_sdk' || !scope.botId || !scope.workspaceId) throw refuse()
  const requested = agentModelSourceSchema.safeParse(selection)
  if (!requested.success) throw refuse()
  const service = dependencies.service()
  const binding = await service.repository.binding(scope.ownerId, requested.data.bindingId)
  const value = hostedSubscriptionSnapshotSchema.parse({
    type: 'subscription', bindingId: binding.id, ownerId: binding.ownerId,
    consumerId: binding.consumerId, workspaceId: binding.workspaceId,
    connectionId: binding.connectionId, connectionRevision: binding.connectionRevision,
    modelId: binding.modelId, route: binding.route,
  })
  checkScope(scope, value)
  await dependencies.workspace(scope.ownerId, value.workspaceId)
  const connection = await service.repository.connection(scope.ownerId, value.connectionId)
  if (connection.ownerId !== scope.ownerId || connection.workspaceId !== value.workspaceId || Number(connection.epoch) !== value.connectionRevision || connection.state !== 'connected') throw refuse()
  return { harness: 'ai_sdk', model: value.modelId, modelSelection: value }
}
/** Re-check the frozen identity, not the latest/default binding, on every model call. */
export async function resolveFrozenHostedModel(scope: HostedModelScope, runtime: HostedRuntimeSnapshot, dependencies: HostedModelDependencies, signal?: AbortSignal): Promise<LanguageModel> {
  cancelled(signal)
  if (runtime.harness !== 'ai_sdk' || !runtime.model) throw refuse()
  if (runtime.modelSelection === undefined) return runtime.model as LanguageModel
  const frozen = hostedSubscriptionSnapshotSchema.parse(runtime.modelSelection)
  checkScope(scope, frozen)
  if (runtime.model !== frozen.modelId) throw refuse()
  const service = dependencies.service()
  const verify = async () => {
    cancelled(signal)
    const binding = await service.repository.binding(scope.ownerId, frozen.bindingId)
    for (const [key, expected] of Object.entries({ id: frozen.bindingId, ownerId: frozen.ownerId, consumerId: frozen.consumerId, workspaceId: frozen.workspaceId, connectionId: frozen.connectionId, connectionRevision: frozen.connectionRevision, modelId: frozen.modelId, route: frozen.route })) {
      if (binding[key as keyof typeof binding] !== expected) throw refuse()
    }
    const connection = await service.repository.connection(scope.ownerId, frozen.connectionId)
    if (connection.ownerId !== frozen.ownerId || connection.workspaceId !== frozen.workspaceId || Number(connection.epoch) !== frozen.connectionRevision || connection.state !== 'connected') throw refuse()
    cancelled(signal)
  }
  await verify()
  const model = await resolveAgentExecutionModel({ ownerId: scope.ownerId, consumerId: frozen.consumerId, source: { type: 'subscription', bindingId: frozen.bindingId }, signal }, {
    defaultModel: () => { throw refuse() }, subscriptionService: () => service, workspace: dependencies.workspace,
  })
  await verify()
  if (typeof model === 'string') throw refuse()
  return new Proxy(model, { get(target, property) {
    const member = Reflect.get(target, property, target)
    if ((property === 'doStream' || property === 'doGenerate') && typeof member === 'function') {
      return async (...args: unknown[]) => { await verify(); return Reflect.apply(member, target, args) }
    }
    return member
  } })
}
