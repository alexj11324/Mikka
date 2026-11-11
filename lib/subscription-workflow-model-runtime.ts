import 'server-only'
import type { SubscriptionModelRequestPolicy } from './subscription-service-tier'
import { resolveFrozenHostedModel, selectionScope, type HostedModelSelection } from './subscription-model-snapshot'
import { authorizeSubscriptionWorkspace, subscriptionRuntime } from './subscription-runtime'
export function resolveSubscriptionWorkflowModel(selection: HostedModelSelection, signal?: AbortSignal, modelRequestPolicy?: SubscriptionModelRequestPolicy) {
  return resolveFrozenHostedModel(selectionScope(selection),
    { harness: 'ai_sdk', model: selection.modelId, modelSelection: selection },
    { service: () => subscriptionRuntime(false, false, { modelRequestPolicy }), workspace: authorizeSubscriptionWorkspace }, signal)
}
