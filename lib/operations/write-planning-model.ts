import type { HostedRuntimeSnapshot } from '@/lib/subscription-model-snapshot'

export const WRITE_PLANNING_MODEL = 'openai/gpt-6-luna'

/** The Gateway model below is documented for both image input and tool use.
 * This is a capability admission check, not evidence that any image was sent
 * or that a particular inference understood one. Unverified routes fail closed. */
export function supportsWritePlanning(runtime: HostedRuntimeSnapshot): boolean {
  return runtime.harness === 'ai_sdk' && runtime.model === WRITE_PLANNING_MODEL && runtime.modelSelection === undefined
}

/** Select the documented Gateway planner only for a new execution whose frozen
 * definition includes write tools. Never replace an explicit subscription. */
export function runtimeForWritePlanning(runtime: HostedRuntimeSnapshot, tools: readonly string[], enabled: boolean, explicitSubscription: boolean): HostedRuntimeSnapshot {
  if (!enabled || explicitSubscription || runtime.harness !== 'ai_sdk' || !tools.some(tool => ['append_notion_paragraph','send_slack_message','cancel_calendar_event'].includes(tool))) return runtime
  return { ...runtime, model:WRITE_PLANNING_MODEL }
}
