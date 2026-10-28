import 'server-only'
import { resolveFrozenHostedModel, type HostedSubscriptionSnapshot } from './subscription-model-snapshot'
import { authorizeSubscriptionWorkspace, subscriptionRuntime } from './subscription-runtime'
export function resolveSubscriptionWorkflowModel(selection: HostedSubscriptionSnapshot, signal?: AbortSignal) {
  return resolveFrozenHostedModel({ ownerId: selection.ownerId, botId: selection.consumerId, workspaceId: selection.workspaceId },
    { harness: 'ai_sdk', model: selection.modelId, modelSelection: selection },
    { service: () => subscriptionRuntime(), workspace: authorizeSubscriptionWorkspace }, signal)
}
