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
  // Like the official Eve client, a connection that closes without
  // stream.ended (a stream lease ending, an edge timeout) is resumed at the
  // next line until the caller's deadline; only stream.ended ends the session.
  const deadline = Date.now() + timeoutMs
  let nextIndex = startIndex, stopped = false
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now()
    if (attempt > 0 && remaining <= 0) return { sessionId: session.sessionId, nextIndex }
    const stream = await client.request(`/api/agents/eve/v1/session/${session.sessionId}/stream?botId=${encodeURIComponent(botId)}&startIndex=${nextIndex}`, {}, attempt ? remaining : timeoutMs)
    if (!stream.ok) { await stream.body?.cancel().catch(() => {}); fail('unavailable', stream.status) }
    if (!stream.body || !stream.headers.get('content-type')?.includes('application/x-ndjson') || stream.headers.get('x-eve-stream-format') !== 'ndjson') { await stream.body?.cancel().catch(() => {}); fail('unavailable') }
    if (stream.headers.get('x-eve-stream-version') !== '27') { await stream.body.cancel().catch(() => {}); fail('version') }
    const reader = stream.body.getReader(), decoder = new TextDecoder()
    let buffer = '', bytes = 0, ended = false, resumable = false
    const accept = async line => {
      if (!line.trim()) return
      let value
      try { value = JSON.parse(line) } catch (error) { fail('invalid', undefined, error) }
      if (value?.$eve) {
        if (value.$eve === 'stream.ended') ended = true
        // The server closes this connection; the session goes on.
        else if (value.$eve === 'stream.lease-ended') resumable = true
        else if (value.$eve === 'position' && Number.isSafeInteger(value.next) && value.next > nextIndex) nextIndex = value.next
        return
      }
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
        for (;;) { const at = buffer.indexOf('\n'); if (at < 0) break; await accept(buffer.slice(0, at)); buffer = buffer.slice(at + 1); if (stopped || ended) break }
        if (done && buffer.trim() && !stopped && !ended) await accept(buffer)
        if (done || stopped || ended) break
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    if (stopped || ended || !resumable) return { sessionId: session.sessionId, nextIndex }
  }
}

/** Native authenticated submission; the caller retains its logical operation UUID. */
export async function submitEveMessage(client, botId, message, submissionId, clientContext = {}, headers = {}) {
  const response = await client.request(`/api/agents/eve/v1/session${botId ? '?botId=' + encodeURIComponent(botId) : ''}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-mikka-submission-id': submissionId },
    body: JSON.stringify({ message, clientContext }),
  })
  const value = await response.json()
  if (response.status !== 202 || value?.ok !== true || !/^wrun_[A-Za-z0-9_-]+$/.test(value.sessionId ?? '') || typeof value.deliveryId !== 'string' || !value.deliveryId) {
    const error = new Error('eve_submission_refused'); error.httpStatus = response.status; error.serverCode = typeof value?.error === 'string' ? value.error : value?.error?.code; throw error
  }
  return value
}
