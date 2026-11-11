import { resolveDefaultHostedModel } from './abuse/resolve'
import type { LanguageModel } from 'ai'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { agentModelSourceSchema } from './agent-model'
import { resolveAgentExecutionModel } from './agent-execution-model'
import type { SubscriptionService } from './subscription-service'

export { hostedSubscriptionSnapshotSchema, hostedApiKeySnapshotSchema, hostedModelSelectionSchema, selectionScope } from './hosted-model-selection'
export type { HostedSubscriptionSnapshot, HostedApiKeySnapshot, HostedModelSelection, HostedRuntimeSnapshot, HostedModelScope } from './hosted-model-selection'
import { hostedSubscriptionSnapshotSchema, hostedApiKeySnapshotSchema, selectionScope, type HostedSubscriptionSnapshot, type HostedRuntimeSnapshot, type HostedModelScope } from './hosted-model-selection'

export interface HostedModelDependencies {
  service(): SubscriptionService
  workspace(ownerId: string, workspaceId: string): Promise<void>
}
const refuse = () => new SubscriptionRefusal('binding_mismatch')
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Model resolution cancelled', 'AbortError')
}
function checkScope(scope: HostedModelScope, value: HostedSubscriptionSnapshot) {
  if (scope.ownerId !== (value.runOwnerId ?? value.ownerId) || value.runOwnerId === value.ownerId || (value.runOwnerId !== undefined && scope.botId === null) || (scope.botId === null ? value.coordinator !== true : scope.botId !== value.consumerId || value.coordinator === true) || scope.workspaceId !== value.workspaceId) throw refuse()
}
/** Called only inside first execution reservation, never before replay lookup. */
export async function freezeHostedModelSelection(scope: HostedModelScope, runtime: HostedRuntimeSnapshot, selection: unknown, dependencies: HostedModelDependencies, subscriptionOwnerId = scope.ownerId): Promise<HostedRuntimeSnapshot & { modelSelection?: HostedSubscriptionSnapshot }> {
  if (selection === undefined) return { harness: runtime.harness, model: runtime.model }
  if (runtime.harness !== 'ai_sdk' || !scope.workspaceId) throw refuse()
  const requested = agentModelSourceSchema.safeParse(selection)
  if (!requested.success) throw refuse()
  const service = dependencies.service()
  const binding = await service.repository.binding(subscriptionOwnerId, requested.data.bindingId)
  const value = hostedSubscriptionSnapshotSchema.parse({
    ...(scope.botId === null ? {coordinator:true} : {}),
    ...(subscriptionOwnerId !== scope.ownerId ? { runOwnerId: scope.ownerId } : {}),
    type: 'subscription', bindingId: binding.id, ownerId: binding.ownerId,
    consumerId: binding.consumerId, workspaceId: binding.workspaceId,
    connectionId: binding.connectionId, connectionRevision: binding.connectionRevision,
    modelId: binding.modelId, route: binding.route,
  })
  checkScope(scope, value)
  await dependencies.workspace(scope.ownerId, value.workspaceId)
  const connection = await service.repository.connection(value.ownerId, value.connectionId)
  // The connection is the subscription owner's, from any workspace; the binding carries the run's workspace.
  if (connection.ownerId !== value.ownerId || Number(connection.epoch) !== value.connectionRevision || connection.state !== 'connected') throw refuse()
  return { harness: 'ai_sdk', model: value.modelId, modelSelection: value }
}
/** Re-check the frozen identity, not the latest/default binding, on every model call. */
export async function resolveFrozenHostedModel(scope: HostedModelScope, runtime: HostedRuntimeSnapshot, dependencies: HostedModelDependencies, signal?: AbortSignal): Promise<LanguageModel> {
  cancelled(signal)
  if (runtime.harness !== 'ai_sdk' || !runtime.model) throw refuse()
  if (runtime.modelSelection === undefined) {
    return resolveDefaultHostedModel(scope,runtime.model)
  }
  if (runtime.modelSelection.type === 'api_key') {
    const frozen = hostedApiKeySnapshotSchema.parse(runtime.modelSelection)
    const expected = selectionScope(frozen)
    if (expected.ownerId !== scope.ownerId || expected.botId !== scope.botId || expected.workspaceId !== scope.workspaceId || runtime.model !== frozen.modelId) throw refuse()
    cancelled(signal)
    const { resolveApiKeyChatModel } = await import('./model-api-key-chat')
    return resolveApiKeyChatModel(frozen)
  }
  const frozen = hostedSubscriptionSnapshotSchema.parse(runtime.modelSelection)
  checkScope(scope, frozen)
  if (runtime.model !== frozen.modelId) throw refuse()
  const service = dependencies.service()
  const verify = async () => {
    cancelled(signal)
    const { assertSubscriptionModelTransport } = await import('./model-admission/runtime')
    await assertSubscriptionModelTransport({ workspaceId: frozen.workspaceId, ownerId: scope.ownerId }, frozen.modelId, frozen.route, signal, false)
    const { binding, connection } = await service.repository.bindingConnection(frozen.ownerId, frozen.bindingId)
    for (const [key, expected] of Object.entries({ id: frozen.bindingId, ownerId: frozen.ownerId, consumerId: frozen.consumerId, workspaceId: frozen.workspaceId, connectionId: frozen.connectionId, connectionRevision: frozen.connectionRevision, modelId: frozen.modelId, route: frozen.route })) {
      if (binding[key as keyof typeof binding] !== expected) throw refuse()
    }
    if (!connection) throw new SubscriptionRefusal('account_unavailable')
    if (connection.ownerId !== frozen.ownerId || Number(connection.epoch) !== frozen.connectionRevision || connection.state !== 'connected') throw refuse()
    cancelled(signal)
  }
  await verify()
  const model = await resolveAgentExecutionModel({ ownerId: frozen.ownerId, consumerId: frozen.consumerId, source: { type: 'subscription', bindingId: frozen.bindingId }, signal }, {
    defaultModel: () => { throw refuse() }, subscriptionService: () => service, workspace: dependencies.workspace,
  })
  await verify()
  if (typeof model === 'string' || model.specificationVersion !== 'v4') throw refuse()
  const { observedModel } = await import('./tracing/ai')
  return observedModel(new Proxy(model, { get(target, property) {
    const member = Reflect.get(target, property, target)
    if ((property === 'doStream' || property === 'doGenerate') && typeof member === 'function') {
      return async (...args: unknown[]) => { await verify(); return Reflect.apply(member, target, args) }
    }
    return member
  } }), { modelId: frozen.modelId, userId: scope.ownerId, route: 'subscription', provider: frozen.route === 'claude_cpa' ? 'anthropic' : 'openai', operation: frozen.coordinator ? 'coordinator' : 'bot' })
}
