import { HostedWorkflowModel } from './abuse/workflow-model'
import { WorkflowAgent, type WorkflowAgentStreamOptions } from '@ai-sdk/workflow'
import type { StopCondition, ToolSet } from 'ai'
import { SubscriptionWorkflowModel } from './subscription-workflow-model'
import type { SubscriptionModelRequestPolicy } from './subscription-service-tier'
import type { HostedRuntimeSnapshot } from './subscription-model-snapshot'
import { getWorkflowMetadata } from 'workflow'
import { GENERATION_FAILURES, generationFailureDetails } from './subscription-generation-diagnostics'
import { CodedError } from '@mikka/protocol/coded-error'
import { invalidToolCalls, invalidToolCounts, invalidToolStepCount, markInvalidToolMessages, MAX_INVALID_TOOL_STEPS } from './coordinator/invalid-tool-call'

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
export async function runHostedWorkflowTurn(runtime: HostedRuntimeSnapshot, tools: ToolSet, options: WorkflowAgentStreamOptions<ToolSet>, scope?: { ownerId:string; botId:string|null }, requestPolicy?: SubscriptionModelRequestPolicy) {
  if (runtime.harness !== 'ai_sdk' || !runtime.model) throw new Error('subscription_model_unavailable')
  if (runtime.modelSelection === undefined && !scope) throw new Error('verification_required')
  if (runtime.modelSelection !== undefined && (!runtime.modelSelection || runtime.model !== runtime.modelSelection.modelId)) throw new Error('subscription_model_unavailable')
  const model = runtime.modelSelection === undefined
    ? new HostedWorkflowModel(scope!.ownerId,scope!.botId,runtime.model)
    : new SubscriptionWorkflowModel(runtime.modelSelection, requestPolicy)
  const toolTimings: ToolTiming[] = []
  // The SDK returns an invalid call to the same model as a tool error. Keep
  // that correction path, but stop after the second invalid step even when
  // it also contains text. Returning null from repairToolCall would not drop it.
  const stopOnInvalidTools: StopCondition<ToolSet> = ({ steps }) => invalidToolStepCount(steps) >= MAX_INVALID_TOOL_STEPS
  const stopWhen = [...(Array.isArray(options.stopWhen) ? options.stopWhen : options.stopWhen ? [options.stopWhen] : []), stopOnInvalidTools]
  const result = await new WorkflowAgent({ model,tools:timedTools(tools,toolTimings,Date.now,options.abortSignal) }).stream({ ...options,stopWhen,maxRetries:0,
    onStepEnd: async step => {
      if (options.onStepEnd) await options.onStepEnd({ ...step, response: { ...step.response, messages: markInvalidToolMessages(step) } })
    },
  })
  if ('error' in result) {
    let workflowRunId: string | null = null
    try { workflowRunId = getWorkflowMetadata().workflowRunId } catch { /* outside a Workflow in unit tests */ }
    const diagnostics = generationFailureDetails(result.error)
    try { console.warn(JSON.stringify({ level: 'warn', msg: 'subscription_generation_failed', stage: 'workflow_result', ...diagnostics, workflowRunId })) } catch { /* diagnostics cannot mask the refusal */ }
    // The first fixed code in the cause chain rides along as the detail (`code (detail)`), so the
    // chat's 详情 can name it (decision 2026-11-05-0330). Never a message: it can carry provider text.
    const detail = [diagnostics, ...diagnostics.causes].find(node => node.errorCode && GENERATION_FAILURES.has(node.errorCode))?.errorCode
    throw new Error(detail ? `subscription_generation_failed (${detail})` : 'subscription_generation_failed', { cause: result.error })
  }
  const invalidSteps = invalidToolStepCount(result.steps)
  // Some providers emit a blank tool name which their parser drops. A
  // tool-calls finish without a call is a malformed response, never success.
  const emptyToolCall = result.finishReason === 'tool-calls' && !result.steps.at(-1)?.toolCalls?.length
  if (invalidSteps || emptyToolCall) {
    let workflowRunId: string | null = null
    try { workflowRunId = getWorkflowMetadata().workflowRunId } catch { /* outside a Workflow in unit tests */ }
    const exhausted = invalidSteps >= MAX_INVALID_TOOL_STEPS || emptyToolCall
    const counts = invalidToolCounts(result.steps, tools)
    if (emptyToolCall) counts.empty++
    const firstInvalidStep = result.steps.findIndex(step => invalidToolCalls(step).length > 0)
    const recoverySteps = firstInvalidStep < 0 ? 0 : Math.min(1, result.steps.length - firstInvalidStep - 1)
    try { console.warn(JSON.stringify({ level:'warn',msg:'model_invalid_tool_call',workflowRunId,model:runtime.model,invalidSteps,recoverySteps,exhausted,counts })) } catch { /* diagnostics never replace the outcome */ }
    if (exhausted) throw new CodedError('model_tool_unavailable', { cause: result.steps.flatMap(invalidToolCalls).at(-1)?.error })
  }
  return { text:result.steps.at(-1)?.text ?? '',finishReason:result.finishReason,responseMessages:result.steps.flatMap(markInvalidToolMessages),toolTimings,modelCalls:result.steps.length }
}
