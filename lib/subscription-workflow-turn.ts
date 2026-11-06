import { HostedWorkflowModel } from './abuse/workflow-model'
import { WorkflowAgent, type WorkflowAgentStreamOptions } from '@ai-sdk/workflow'
import type { ToolSet } from 'ai'
import { SubscriptionWorkflowModel } from './subscription-workflow-model'
import type { HostedRuntimeSnapshot } from './subscription-model-snapshot'
import { getWorkflowMetadata } from 'workflow'
import { generationFailureDetails } from './subscription-generation-diagnostics'

/** How long one tool call took, by name only (no input or output). */
export type ToolTiming = { tool: string; ms: number; failed: boolean }

/** What a tool call returns when 停止 came before it started: it never runs (lib/coordinator/stop.ts). */
export const STOPPED_TOOL_RESULT = { error: 'stopped' } as const

/**
 * The same tools, each call timed. Runs in the Workflow body, whose clock is
 * the durable event time, so a duration counts the steps the tool waited on.
 * After 停止 (`signal`) a call that has not started does not run.
 */
export function timedTools(tools: ToolSet, timings: ToolTiming[], now: () => number = Date.now, signal?: { readonly aborted: boolean }): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
    const execute = entry.execute
    if (!execute) return [name, entry]
    return [name, { ...entry, execute: async (...args: Parameters<typeof execute>) => {
      if (signal?.aborted) return STOPPED_TOOL_RESULT
      const start = now()
      let failed = true
      try {
        const output = await execute(...args)
        failed = false
        return output
      } finally { timings.push({ tool: name, ms: now() - start, failed }) }
    } }]
  })) as ToolSet
}

/** Retains the Workflow tool loop and the selected model's admission boundary. */
export async function runHostedWorkflowTurn(runtime: HostedRuntimeSnapshot, tools: ToolSet, options: WorkflowAgentStreamOptions<ToolSet>, scope?: { ownerId:string; botId:string|null }) {
  if (runtime.harness !== 'ai_sdk' || !runtime.model) throw new Error('subscription_model_unavailable')
  if (runtime.modelSelection === undefined && !scope) throw new Error('verification_required')
  if (runtime.modelSelection !== undefined && (!runtime.modelSelection || runtime.model !== runtime.modelSelection.modelId)) throw new Error('subscription_model_unavailable')
  const model = runtime.modelSelection === undefined
    ? new HostedWorkflowModel(scope!.ownerId,scope!.botId,runtime.model)
    : new SubscriptionWorkflowModel(runtime.modelSelection)
  const toolTimings: ToolTiming[] = []
  const result = await new WorkflowAgent({ model,tools:timedTools(tools,toolTimings,Date.now,options.abortSignal) }).stream({ ...options,maxRetries:0 })
  if ('error' in result) {
    let workflowRunId: string | null = null
    try { workflowRunId = getWorkflowMetadata().workflowRunId } catch { /* outside a Workflow in unit tests */ }
    try { console.warn(JSON.stringify({ level: 'warn', msg: 'subscription_generation_failed', stage: 'workflow_result', ...generationFailureDetails(result.error), workflowRunId })) } catch { /* diagnostics cannot mask the refusal */ }
    throw new Error('subscription_generation_failed')
  }
  return { text:result.steps.at(-1)?.text ?? '',finishReason:result.finishReason,responseMessages:result.steps.flatMap(step => step.response.messages),toolTimings,modelCalls:result.steps.length }
}
