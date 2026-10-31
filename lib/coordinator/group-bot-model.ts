import type { PoolClient } from 'pg'
import type { HostedModelScope, HostedRuntimeSnapshot } from '@/lib/subscription-model-snapshot'

/** Use the same Bot binding choice and frozen non-secret references as its
 * private chat: no choice and no subscription runs the hosted default; a
 * missing chosen binding refuses.
 */
export async function freezeGroupBotModel(scope: HostedModelScope, client: PoolClient): Promise<HostedRuntimeSnapshot> {
  const [{ freezeBotModel }, { subscriptionRuntime, authorizeSubscriptionWorkspace }, { withDatabaseClient }, { hostedSubscriptionSnapshotSchema }] = await Promise.all([
    import('@/lib/bot-model-selection'), import('@/lib/subscription-runtime'), import('@/lib/db'), import('@/lib/subscription-model-snapshot'),
  ])
  const value = await withDatabaseClient(client, () => freezeBotModel(scope, { service: () => subscriptionRuntime(), workspace: authorizeSubscriptionWorkspace }))
  return { harness: value.harness, model: value.model, ...(value.modelSelection === undefined ? {} : { modelSelection: hostedSubscriptionSnapshotSchema.parse(value.modelSelection) }) }
}

export async function resolveGroupBotModel(scope: HostedModelScope, runtime: HostedRuntimeSnapshot, signal: AbortSignal) {
  const [{ resolveFrozenHostedModel }, { subscriptionRuntime, authorizeSubscriptionWorkspace }] = await Promise.all([
    import('@/lib/subscription-model-snapshot'), import('@/lib/subscription-runtime'),
  ])
  return resolveFrozenHostedModel(scope, runtime, { service: () => subscriptionRuntime(), workspace: authorizeSubscriptionWorkspace }, signal)
}
