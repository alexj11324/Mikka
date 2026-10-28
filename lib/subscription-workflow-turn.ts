import { WorkflowAgent, type WorkflowAgentCallOptions } from '@ai-sdk/workflow'
import type { ToolSet } from 'ai'
import { SubscriptionWorkflowModel } from './subscription-workflow-model'
import type { HostedRuntimeSnapshot } from './subscription-model-snapshot'

/** Retains the existing Workflow tool loop; only subscription calls use its
 * streaming mode because the subscription worker is intentionally stream-only. */
export async function runHostedWorkflowTurn(runtime: HostedRuntimeSnapshot, tools: ToolSet, options: WorkflowAgentCallOptions<ToolSet>) {
  if (runtime.harness !== 'ai_sdk' || !runtime.model) throw new Error('subscription_model_unavailable')
  if (runtime.modelSelection === undefined) return new WorkflowAgent({ model:runtime.model,tools }).generate(options)
  if (!runtime.modelSelection) throw new Error('subscription_model_unavailable')
  if (runtime.model !== runtime.modelSelection.modelId) throw new Error('subscription_model_unavailable')
  const result = await new WorkflowAgent({ model:new SubscriptionWorkflowModel(runtime.modelSelection),tools }).stream({ ...options,maxRetries:0 })
  if ('error' in result) throw new Error('subscription_generation_failed')
  return { text:result.steps.at(-1)?.text ?? '',finishReason:result.finishReason,responseMessages:result.steps.flatMap(step => step.response.messages) }
}
