import { resolveDefaultHostedModel } from './abuse/resolve'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { agentModelSourceSchema } from './agent-model'
import { resolveAgentExecutionModel } from './agent-execution-model'
import type { SubscriptionService } from './subscription-service'

export const hostedSubscriptionSnapshotSchema = z.strictObject({
  coordinator: z.literal(true).optional(),
  type: z.literal('subscription'), bindingId: z.uuid(), ownerId: z.string().min(1),
  consumerId: z.uuid(), workspaceId: z.uuid(), connectionId: z.uuid(),
  /** Set when the bot runs on another member's shared subscription (allowOthers): the run's owner. `ownerId` is the subscription's. */
  runOwnerId: z.string().min(1).optional(),
  connectionRevision: z.number().int().positive(), modelId: z.string().min(1).max(128),
  route: z.enum(['codex_cpa', 'claude_cpa', 'openai_siwc']),
})
export type HostedSubscriptionSnapshot = z.infer<typeof hostedSubscriptionSnapshotSchema>
/**
 * A bot chat frozen on a model an API key or custom provider serves (C22).
 * `ownerId` is the bot's owner; the key may be a teammate's shared one. No key material.
 */
export const hostedApiKeySnapshotSchema = z.strictObject({
  coordinator: z.literal(true).optional(),
  type: z.literal('api_key'), keyId: z.uuid(), ownerId: z.string().min(1),
  consumerId: z.uuid().optional(), workspaceId: z.uuid(), modelId: z.string().min(1).max(128),
  /** 订阅额度用完后，自动改用 API Key: the subscription this turn would have used, out of quota, and the person's own key it runs on instead. */
  afterQuota: z.strictObject({
    subscription: z.enum(['claude', 'codex']), plan: z.string().max(60).nullable(),
    keyProvider: z.string().min(1).max(20), keyName: z.string().max(60).nullable(),
  }).optional(),
})
export type HostedApiKeySnapshot = z.infer<typeof hostedApiKeySnapshotSchema>
export const hostedModelSelectionSchema = z.discriminatedUnion('type', [hostedSubscriptionSnapshotSchema, hostedApiKeySnapshotSchema])
export type HostedModelSelection = z.infer<typeof hostedModelSelectionSchema>
export interface HostedRuntimeSnapshot {
  harness: string
  model: string | null
  modelSelection?: HostedModelSelection
}
/** The bot scope a frozen selection belongs to. */
export const selectionScope = (selection: HostedModelSelection): HostedModelScope => ({
  ownerId: selection.type === 'subscription' ? selection.runOwnerId ?? selection.ownerId : selection.ownerId,
  botId: selection.coordinator ? null : selection.consumerId ?? null,
  workspaceId: selection.workspaceId,
})
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
    const binding = await service.repository.binding(frozen.ownerId, frozen.bindingId)
    for (const [key, expected] of Object.entries({ id: frozen.bindingId, ownerId: frozen.ownerId, consumerId: frozen.consumerId, workspaceId: frozen.workspaceId, connectionId: frozen.connectionId, connectionRevision: frozen.connectionRevision, modelId: frozen.modelId, route: frozen.route })) {
      if (binding[key as keyof typeof binding] !== expected) throw refuse()
    }
    const connection = await service.repository.connection(frozen.ownerId, frozen.connectionId)
    if (connection.ownerId !== frozen.ownerId || Number(connection.epoch) !== frozen.connectionRevision || connection.state !== 'connected') throw refuse()
    cancelled(signal)
  }
  await verify()
  const model = await resolveAgentExecutionModel({ ownerId: frozen.ownerId, consumerId: frozen.consumerId, source: { type: 'subscription', bindingId: frozen.bindingId }, signal }, {
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
