/** Bound decoded bytes while reading, before allocating the final response body. */
export async function readBoundedBody(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('RESPONSE_BODY_LIMIT_INVALID')
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    void response.body?.cancel().catch(() => {})
    throw new Error('RESPONSE_BODY_TOO_LARGE')
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) throw new Error('RESPONSE_BODY_TOO_LARGE')
      chunks.push(chunk.value)
    }
  } finally {
    // A malicious cancellation promise must not hold the bounded client open.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}
