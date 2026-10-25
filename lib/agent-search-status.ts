import type { UIMessageChunk } from 'ai'

/** #63's existing transient status contract. No provider error details or evidence in notices. */
export function agentSearchStatusStream() {
  let step = 0
  const tools = new Map<string, string>()
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(part, controller) {
      if (part.type === 'start-step') { step++; tools.clear() }
      if (part.type === 'tool-input-start') tools.set(part.toolCallId, part.toolName)
      if (part.type === 'tool-output-available') {
        const tool = tools.get(part.toolCallId)
        const output = part.output
        if ((tool === 'web_search' || tool === 'read_webpage') && typeof output === 'object' && output !== null
          && 'notice' in output && output.notice === 'search_degraded') {
          controller.enqueue({ type: 'data-agent-status', transient: true,
            data: { phase: tool === 'web_search' ? 'searching' : 'reading', tool, step, notice: 'search_degraded' } })
        }
      }
      controller.enqueue(part)
    },
  })
}
