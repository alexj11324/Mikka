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
            ? '本次生成达到输出上限，回复未完整生成。已有内容已保留，可以在此重试。'
            : '模型未返回正文，请在此重试。' })
          failed = true
        }
      }
      controller.enqueue(part)
    },
    flush(controller) {
      if (!finished && !failed) controller.enqueue({ type: 'error', errorText: '回复连接提前结束，已有内容已保留，请在此重试。' })
    },
  })
}

export const fetchAgentResponse: typeof fetch = async (input, options) => {
  const signal = options?.signal
  if (!signal) return fetch(input, options)
  signal.throwIfAborted()

  let handleAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    handleAbort = () => reject(signal.reason ?? new DOMException('请求已停止', 'AbortError'))
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
