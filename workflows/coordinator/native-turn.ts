import type { DefinitionSnapshot } from '@/lib/agent-kit/definition'
import { asSchema, type ModelMessage, type ToolSet } from 'ai'
import { createHook, sleep } from 'workflow'
import type { CoordinatorRuntime, NativeCoordinatorJob } from '@mikka/protocol/coordinator'
import * as native from './native-steps'
import type { NativeToolScope } from './tool-scope'
import { nativeTurnToken } from './native-wake'
import { captureRunFailure, RunFailureError } from '@mikka/protocol/run-failure'

/** The device's job expires 180 s after it is queued (lib/coordinator/native-store.ts). */
const NATIVE_TURN_MS = 180_000
/** The device route wakes the turn after each call or reply; this re-read only covers a lost wake. */
export const NATIVE_TURN_FALLBACK_MS = 15_000

/** A durable transport relay, not an additional LLM/agent loop. Native harness chooses tools. */
export async function nativeCoordinatorTurn(userId: string, holder: string, round: number, runtime: Exclude<CoordinatorRuntime, { harness: 'ai_sdk' }>, createTools: (scope?: NativeToolScope) => ToolSet, botId: string, snapshot?: DefinitionSnapshot, signal?: AbortSignal, finished: ModelMessage[] = []) {
  const tools = createTools()
  const definitions: NativeCoordinatorJob['tools'] = []
  for (const [name, definition] of Object.entries(tools)) {
    if (definition.type === 'provider' || !definition.execute) continue
    definitions.push({ name, description: typeof definition.description === 'string' ? definition.description : name, inputSchema: await asSchema(definition.inputSchema).jsonSchema as Record<string, unknown> })
  }
  const turnId = snapshot
    ? await native.enqueue(userId,holder,round,runtime,definitions,botId,snapshot)
    : await native.enqueue(userId,holder,round,runtime,definitions,botId)
  // Each finished tool call lands here as it finishes, so 停止 keeps it without waiting for the device (workflow.ts).
  const responseMessages = finished
  const completed = new Map<string, unknown>()
  const deadline = Date.now() + NATIVE_TURN_MS
  // Woken by the device's writes (app/v1/devices/[deviceId]/coordinator), not a 1 s re-read (#1212).
  const changed = createHook<Record<string, never>>({ token: nativeTurnToken(turnId) })
  const stopped = new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }) })
  try {
    for (;;) {
      // 停止: closing the turn below refuses the device's later tool calls and reply.
      if (signal?.aborted) return { text: '', responseMessages, finishReason: 'stop' }
      const state = await native.poll(userId,holder,turnId)
      if (state.status === 'failed' || state.status === 'closed') throw new RunFailureError(captureRunFailure(state.failureDetails ? { failureDetails: state.failureDetails } : new Error('nativeCoordinatorFailed'), { runId: holder, provider: runtime.harness, credential: 'subscription' }))
      for (const call of state.calls) {
        if (!completed.has(call.callId)) {
          const selected = createTools({ holder, turnId, callId: call.callId })[call.name]
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
      // A last read at the deadline, so a reply that just landed is not lost.
      if (Date.now() >= deadline) break
      await Promise.race([changed, stopped, sleep(Math.max(1_000, Math.min(NATIVE_TURN_FALLBACK_MS, deadline - Date.now())))])
    }
    throw new RunFailureError(captureRunFailure({ name: 'TimeoutError', code: 'ETIMEDOUT' }, { runId: holder, provider: runtime.harness, credential: 'subscription' }))
  } finally { changed.dispose(); await native.close(userId,holder,turnId) }
}
