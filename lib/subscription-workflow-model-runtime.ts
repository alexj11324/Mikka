import 'server-only'
import { resolveFrozenHostedModel, selectionScope, type HostedModelSelection } from './subscription-model-snapshot'
import { authorizeSubscriptionWorkspace, subscriptionRuntime } from './subscription-runtime'
export function resolveSubscriptionWorkflowModel(selection: HostedModelSelection, signal?: AbortSignal) {
  return resolveFrozenHostedModel(selectionScope(selection),
    { harness: 'ai_sdk', model: selection.modelId, modelSelection: selection },
    { service: () => subscriptionRuntime(), workspace: authorizeSubscriptionWorkspace }, signal)
}
