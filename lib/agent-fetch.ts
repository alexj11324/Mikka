import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import type { UIMessageChunk } from 'ai'

export function validateAgentStream() {
  let hasText = false
  let failed = false
  let finished = false
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(part, controller) {
      if (part.type === 'text-delta' && part.delta.trim()) hasText = true
      if (part.type === 'error') failed = true
      if (part.type === 'abort') finished = true
      if (part.type === 'finish') {
        finished = true
        if (!failed && (part.finishReason === 'length' || !hasText)) {
          controller.enqueue({ type: 'error', errorText: part.finishReason === 'length'
            ? agentCopy.theModelReachedItsOutputLimitAnd
            : agentCopy.theModelReturnedNoResponseContentPlease })
          failed = true
        }
      }
      controller.enqueue(part)
    },
    flush(controller) {
      if (!finished && !failed) controller.enqueue({ type: 'error', errorText: agentCopy.theResponseEndedEarlyReceivedContentIs })
    },
  })
}

export function observeAgentImages(onQuery: (query: string) => void) {
  const decoder = new TextDecoder()
  const seen = new Set<string>()
  let pending = ''
  let text = ''
  const patterns = [/\bBeImageCard\s*\(\s*"(?:[^"\\]|\\.)*"\s*,\s*("(?:[^"\\]|\\.)*")/g, /\bBeImage\s*\(\s*("(?:[^"\\]|\\.)*")/g]
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      if (seen.size >= 6) return
      pending += decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (!line.startsWith('data: ') || line.slice(6).trim() === '[DONE]') continue
        try {
          const part = JSON.parse(line.slice(6))
          if (part.type !== 'text-delta' || typeof part.delta !== 'string') continue
          text += part.delta
          for (const pattern of patterns) {
            for (const match of text.matchAll(pattern)) {
              const query: string = JSON.parse(match[1])
              if (!seen.has(query) && seen.size < 6) {
                seen.add(query)
                onQuery(query)
              }
            }
          }
          text = text.slice(-16384)
        } catch { /* Observation must never interrupt the original response stream. */ }
      }
    },
  })
}

export const fetchAgentResponse: typeof fetch = async (input, options) => {
  const signal = options?.signal
  if (!signal) return fetch(input, options)
  signal.throwIfAborted()

  let handleAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    handleAbort = () => reject(signal.reason ?? new DOMException(agentCopy.requestStopped, 'AbortError'))
    signal.addEventListener('abort', handleAbort, { once: true })
  })

  try {
    const response = await Promise.race([fetch(input, options), aborted])
    if (!response.body) return response
    // Preview transports may not abort their response body when fetch is aborted.
    return new Response(response.body.pipeThrough(new TransformStream(), { signal }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } finally {
    signal.removeEventListener('abort', handleAbort)
  }
}
