import type { SubscriptionService } from './subscription-service'

/** Shared app boundary: owner is session-derived; scope/model come from binding. */
export async function resolveAgentSubscription(ownerId: string, consumerId: string, bindingId: string, service: SubscriptionService, workspace: (ownerId: string, workspaceId: string) => Promise<void>, signal?: AbortSignal) {
  const binding = await service.repository.binding(ownerId, bindingId)
  await workspace(ownerId, binding.workspaceId)
  return service.model({ ownerId, workspaceId: binding.workspaceId, consumerId, bindingId, execution: 'model' }, signal)
}
