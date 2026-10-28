import type { ModelMessage, ToolSet } from 'ai'
import { selectRegisteredTools } from './registry'

export type ToolOutcome = 'ok' | 'error' | 'approval_pending'
export function toolOutcome(output: unknown): ToolOutcome {
  if (output && typeof output === 'object') {
    if ('error' in output && output.error) return 'error'
    if ('status' in output && ['pending','pending_approval','proposed'].includes(String(output.status))) return 'approval_pending'
    if ('approvalRequired' in output && output.approvalRequired === true) return 'approval_pending'
  }
  return 'ok'
}
interface ToolContext { toolCallId: string; messages: ModelMessage[] }

/** Hooks observe a host-controlled call; they cannot replace the authorized implementation. */
export function instrumentTools(registry: ToolSet, requested: readonly string[], hooks: {
  before: (callId: string, name: string) => Promise<void>
  after: (callId: string, name: string, outcome: ToolOutcome) => Promise<void>
}): ToolSet {
  const selected = selectRegisteredTools(registry,requested)
  return Object.fromEntries(Object.entries(selected).map(([name, definition]) => {
    if (!definition.execute || definition.type === 'provider') throw new Error(`agentToolNotExecutable:${name}`)
    const execute = definition.execute as (input: unknown, context: ToolContext) => unknown
    return [name, { ...definition, execute:async (input: unknown, context: ToolContext) => {
      await hooks.before(context.toolCallId,name)
      let output: unknown
      try {
        output = await execute(input,context)
        if (output && typeof output === 'object' && Symbol.asyncIterator in output) throw new Error('agentStreamingToolUnsupported')
      } catch (error) {
        await hooks.after(context.toolCallId,name,'error')
        throw error
      }
      // Outside the execute catch: an audit outage must not turn a successful effect into an error receipt.
      await hooks.after(context.toolCallId,name,toolOutcome(output))
      return output
    } }]
  })) as ToolSet
}
