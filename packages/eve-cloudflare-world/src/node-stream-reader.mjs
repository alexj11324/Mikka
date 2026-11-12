/** The caller supplies the host's authenticated private Cloudflare transport.
 * The official World gets opaque bytes and owns the Eve protocol above them. */
export function createNodeStreamReader(fetchBound) {
  return async function get(runId, name, start = 0) {
    const url = new URL('https://world.internal/world/stream')
    url.search = new URLSearchParams({ runId, name, start: String(start), subscriber: crypto.randomUUID() })
    const response = await fetchBound(url, { headers: { 'accept-encoding': 'identity' } })
    if (!response.ok || !response.body) throw new Error('Cloudflare World stream read failed')
    const reader = response.body.getReader()
    let release
    const releaseOnce = () => release ??= (async () => {
      const result = await fetchBound(url, { method: 'DELETE' })
      if (!result.ok) throw new Error('Cloudflare World subscription release failed')
    })()
    return new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) controller.close()
          else controller.enqueue(value)
        } catch (error) {
          try { await releaseOnce() } finally { controller.error(error) }
        }
      },
      async cancel(reason) {
        // The explicit release and the transport cancellation race. A peer that
        // already processed DELETE may have errored the pending read while we
        // were cancelling it. The authoritative receipt is the release response.
        const [releaseResult] = await Promise.allSettled([releaseOnce(), reader.cancel(reason)])
        if (releaseResult.status === 'rejected') throw releaseResult.reason
      },
    })
  }
}
