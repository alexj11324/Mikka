/** Operational acceptance reader for the documented eve v27 HTTP protocol.
 * Keeps the existing authenticated transport; this is not a runtime/UI codec. */
export async function observeEveSession(client, botId, { timeoutMs = 120_000, startIndex = 0, previousSessionId, onEvent, fail = code => { throw new Error(code) } } = {}) {
  const response = await client.request(`/api/agents/eve/v1/session?botId=${encodeURIComponent(botId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }, timeoutMs)
  if (!response.ok) { await response.body?.cancel().catch(() => {}); fail('unavailable', response.status) }
  let session
  try { session = await response.json() } catch (error) { fail('invalid', undefined, error) }
  if (session?.ok !== true || !/^wrun_[A-Za-z0-9_-]+$/.test(session.sessionId ?? '')) fail('identity')
  if (previousSessionId && previousSessionId !== session.sessionId) startIndex = 0
  const stream = await client.request(`/api/agents/eve/v1/session/${session.sessionId}/stream?botId=${encodeURIComponent(botId)}&startIndex=${startIndex}`, {}, timeoutMs)
  if (!stream.ok) { await stream.body?.cancel().catch(() => {}); fail('unavailable', stream.status) }
  if (!stream.body || !stream.headers.get('content-type')?.includes('application/x-ndjson') || stream.headers.get('x-eve-stream-format') !== 'ndjson') { await stream.body?.cancel().catch(() => {}); fail('unavailable') }
  if (stream.headers.get('x-eve-stream-version') !== '27') { await stream.body.cancel().catch(() => {}); fail('version') }
  const reader = stream.body.getReader(), decoder = new TextDecoder()
  let buffer = '', bytes = 0, nextIndex = startIndex, stopped = false
  const accept = async line => {
    if (!line.trim()) return
    let value
    try { value = JSON.parse(line) } catch (error) { fail('invalid', undefined, error) }
    if (value?.$eve) { if (value.$eve === 'stream.ended') stopped = true; return }
    if (Array.isArray(value?.facts) && typeof value.at === 'string') {
      if (value.facts.length > 10_000) fail('invalid')
      for (const [index, fact] of value.facts.entries()) {
        if (!fact || typeof fact.type !== 'string' || !fact.data || typeof fact.data !== 'object') fail('invalid')
        if (await onEvent?.({ ...fact, meta: { position: { line: nextIndex, index }, at: value.at, endOfLine: index === value.facts.length - 1 } }, session.sessionId)) stopped = true
      }
      nextIndex++
    } else if (value?.progress) nextIndex++
    else fail('invalid')
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      bytes += value?.byteLength ?? 0
      if (bytes > 8_000_000) fail('too_large')
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (buffer.length > 1_000_000) fail('too_large')
      for (;;) { const at = buffer.indexOf('\n'); if (at < 0) break; await accept(buffer.slice(0, at)); buffer = buffer.slice(at + 1); if (stopped) break }
      if (done && buffer.trim() && !stopped) await accept(buffer)
      if (done || stopped) return { sessionId: session.sessionId, nextIndex }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
