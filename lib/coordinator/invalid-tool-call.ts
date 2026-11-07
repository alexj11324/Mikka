import type { ModelMessage } from 'ai'

/** A failed parse can get one corrective model step, never a 120-step loop. */
export const MAX_INVALID_TOOL_STEPS = 2
export const INVALID_TOOL_ERROR_PATTERN = '^AI_(NoSuchTool|InvalidToolInput)Error(:|$)'
const invalidError = new RegExp(INVALID_TOOL_ERROR_PATTERN)

type Part = { type?: string; toolCallId?: string; toolName?: string; invalid?: boolean; mikkaInvalidToolCall?: boolean; error?: unknown; output?: unknown }
type ResponseMessage = Extract<ModelMessage, { role: 'assistant' | 'tool' }>
type ToolStep = { toolCalls?: readonly Part[]; response?: { messages: ResponseMessage[] } }

function isInvalidToolError(value: unknown): boolean {
  if (typeof value === 'string') return invalidError.test(value)
  return Boolean(value && typeof value === 'object' && 'name' in value && typeof value.name === 'string' && invalidError.test(value.name))
}

/** Old SDK response.messages omit invalid:true. Recognize the SDK's own
 * error envelope, never a tool name or a substring inside arbitrary output. */
export function isInvalidToolResult(part: Part): boolean {
  if (part.mikkaInvalidToolCall === true) return true
  if (part.type === 'tool-error') return isInvalidToolError(part.error)
  if (part.type !== 'tool-result' || !part.output || typeof part.output !== 'object') return false
  const output = part.output as { type?: unknown; value?: unknown }
  return typeof output.type === 'string' && output.type.startsWith('error') && isInvalidToolError(output.value)
}

export function invalidToolCalls(step: ToolStep): Part[] {
  return (step.toolCalls ?? []).filter(call => call.invalid === true || isInvalidToolError(call.error))
}

export function invalidToolStepCount(steps: readonly ToolStep[]): number {
  return steps.filter(step => invalidToolCalls(step).length > 0).length
}

/** Names and inputs can contain arbitrary model output: only fixed counters
 * leave the process. A normal tool's execution failure is not a parse failure. */
export function invalidToolCounts(steps: readonly ToolStep[], tools: Readonly<Record<string, unknown>>) {
  const counts = { none: 0, empty: 0, unknown: 0, input: 0 }
  for (const call of steps.flatMap(invalidToolCalls)) {
    const name = call.toolName ?? ''
    const kind = !name.trim() ? 'empty' : name === 'none' ? 'none' : Object.hasOwn(tools, name) ? 'input' : 'unknown'
    counts[kind]++
  }
  return counts
}

/** Preserve the raw evidence for the next model step and server diagnostics,
 * with a host marker that survives the SDK's response-message projection. */
export function markInvalidToolMessages(step: ToolStep): ResponseMessage[] {
  const ids = new Set(invalidToolCalls(step).map(call => call.toolCallId))
  return (step.response?.messages ?? []).map(message => {
    if ((message.role !== 'assistant' && message.role !== 'tool') || !Array.isArray(message.content)) return message
    return { ...message, content: message.content.map(part =>
      (part.type === 'tool-call' || part.type === 'tool-result') && ids.has(part.toolCallId)
        ? { ...part, mikkaInvalidToolCall: true } : part) } as ResponseMessage
  })
}

/** Pair within the current sequence, so a later bad call cannot hide an
 * earlier valid call that happens to reuse its id. Also handles legacy rows. */
export function invalidToolParts(messages: readonly ModelMessage[]): Set<object> {
  const hidden = new Set<object>()
  const pending = new Map<string, Part>()
  for (const message of messages) {
    if (message.role === 'user') pending.clear()
    if (!Array.isArray(message.content)) continue
    for (const value of message.content) {
      const part = value as Part
      if (part.type === 'tool-call' && part.toolCallId) {
        pending.set(part.toolCallId, part)
        if (part.invalid === true || part.mikkaInvalidToolCall === true) hidden.add(part)
      } else if (part.type === 'tool-result' && part.toolCallId) {
        const call = pending.get(part.toolCallId)
        if (isInvalidToolResult(part) || (call && hidden.has(call))) {
          hidden.add(part)
          if (call && (part.toolName === undefined || call.toolName === part.toolName)) hidden.add(call)
        }
        pending.delete(part.toolCallId)
      }
    }
  }
  return hidden
}
