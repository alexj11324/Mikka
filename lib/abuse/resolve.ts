import type { HostedModelScope } from '../subscription-model-snapshot'
/** Keep Node billing/custody out of the Workflow VM schema imports. */
export async function resolveDefaultHostedModel(
  scope: HostedModelScope,
  modelId: string,
) {
  'use step'
  const { executionWorkspace } = await import('../execution-settings')
  const { hostedModel } = await import('./model')
  return hostedModel(
    scope.workspaceId ?? (await executionWorkspace(scope.ownerId, scope.botId)),
    modelId,
    undefined,
    scope.ownerId,
  )
}
