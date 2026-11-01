import { HostedWorkflowModel } from './abuse/workflow-model'
import { WorkflowAgent, type WorkflowAgentStreamOptions } from '@ai-sdk/workflow'
import type { ToolSet } from 'ai'
import { SubscriptionWorkflowModel } from './subscription-workflow-model'
import { ApiKeyWorkflowModel } from './api-key-workflow-model'
import type { HostedRuntimeSnapshot } from './subscription-model-snapshot'

/** Retains the Workflow tool loop and the selected model's admission boundary. */
export async function runHostedWorkflowTurn(runtime: HostedRuntimeSnapshot, tools: ToolSet, options: WorkflowAgentStreamOptions<ToolSet>, scope?: { ownerId:string; botId:string|null }) {
  if (runtime.harness !== 'ai_sdk' || !runtime.model) throw new Error('subscription_model_unavailable')
  // A workspace-added API-key model carries its own frozen reference; the key is resolved in the model step.
  if (runtime.apiKeySelection !== undefined) {
    if (runtime.model !== runtime.apiKeySelection.modelId) throw new Error('api_key_model_unavailable')
  } else {
    if (runtime.modelSelection === undefined && !scope) throw new Error('verification_required')
    if (runtime.modelSelection !== undefined && (!runtime.modelSelection || runtime.model !== runtime.modelSelection.modelId)) throw new Error('subscription_model_unavailable')
  }
  const model = runtime.apiKeySelection !== undefined
    ? new ApiKeyWorkflowModel(runtime.apiKeySelection)
    : runtime.modelSelection === undefined
    ? new HostedWorkflowModel(scope!.ownerId,scope!.botId,runtime.model)
    : new SubscriptionWorkflowModel(runtime.modelSelection)
  const result = await new WorkflowAgent({ model,tools }).stream({ ...options,maxRetries:0 })
  if ('error' in result) throw new Error('subscription_generation_failed')
  return { text:result.steps.at(-1)?.text ?? '',finishReason:result.finishReason,responseMessages:result.steps.flatMap(step => step.response.messages) }
}
