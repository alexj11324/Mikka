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
