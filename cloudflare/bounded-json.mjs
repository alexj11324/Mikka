export async function boundedJson(request, limit) {
  if (!request.body || Number(request.headers.get('content-length')) > limit) throw new RangeError()
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0, json = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) { await reader.cancel(); throw new RangeError() }
      json += decoder.decode(value, { stream: true })
    }
    return JSON.parse(json + decoder.decode())
  } finally { reader.releaseLock() }
}
