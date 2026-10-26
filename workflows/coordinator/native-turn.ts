import { asSchema, type ModelMessage, type ToolSet } from 'ai'
import { sleep } from 'workflow'
import type { CoordinatorRuntime, NativeCoordinatorJob } from '@mikka/protocol/coordinator'
import * as native from './native-steps'

/** A durable transport relay, not an additional LLM/agent loop. Native harness chooses tools. */
export async function nativeCoordinatorTurn(userId: string, holder: string, round: number, runtime: Exclude<CoordinatorRuntime, { harness: 'ai_sdk' }>, tools: ToolSet) {
  const definitions: NativeCoordinatorJob['tools'] = []
  for (const [name, definition] of Object.entries(tools)) {
    if (definition.type === 'provider' || !definition.execute) continue
    definitions.push({ name, description: typeof definition.description === 'string' ? definition.description : name, inputSchema: await asSchema(definition.inputSchema).jsonSchema as Record<string, unknown> })
  }
  const turnId = await native.enqueue(userId,holder,round,runtime,definitions)
  const responseMessages: ModelMessage[] = []
  const completed = new Map<string, unknown>()
  try {
    for (let attempt = 0; attempt < 180; attempt++) {
      const state = await native.poll(userId,holder,turnId)
      if (state.status === 'failed' || state.status === 'closed') throw new Error('nativeCoordinatorFailed: check the selected device and CLI login')
      for (const call of state.calls) {
        if (!completed.has(call.callId)) {
          const selected = tools[call.name]
          if (!selected?.execute || selected.type === 'provider') throw new Error('nativeCoordinatorUnknownTool')
          const checked = await asSchema(selected.inputSchema).validate?.(call.input)
          if (!checked?.success) {
            completed.set(call.callId, { error: 'invalidToolArguments' })
          } else {
            // These are the SAME durable, person-scoped tool functions used by
            // WorkflowAgent. Native input never gets to choose the actor identity.
            const execute = selected.execute as (input: unknown, context: { toolCallId: string; messages: ModelMessage[] }) => unknown
            const output = await execute(checked.value, { toolCallId: call.callId, messages: responseMessages })
            if (output && typeof output === 'object' && Symbol.asyncIterator in output) throw new Error('nativeCoordinatorStreamingToolUnsupported')
            completed.set(call.callId, output ?? null)
            responseMessages.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: call.callId, toolName: call.name, input: checked.value }] })
            responseMessages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: call.callId, toolName: call.name, output: { type: 'json', value: JSON.parse(JSON.stringify(output ?? null)) } }] })
          }
        }
        await native.finishTool(userId,holder,turnId,call.callId,completed.get(call.callId))
      }
      if (state.status === 'completed') {
        if (!state.reply?.trim()) throw new Error('nativeCoordinatorEmptyReply')
        responseMessages.push({ role: 'assistant', content: state.reply })
        return { text: state.reply, responseMessages, finishReason: 'stop' }
      }
      await sleep('1s')
    }
    throw new Error('nativeCoordinatorTimedOut: no fallback model was used')
  } finally { await native.close(userId,holder,turnId) }
}
