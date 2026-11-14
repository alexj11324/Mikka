import { StreamDO } from '@fantasticfour/world-cloudflare/worker'

const encoder = new TextEncoder()
const batchSize = 32

/** The upstream class owns durable chunk ordering, storage and close. A
 * hibernatable WebSocket is only a wake-up for live readers. Its messages
 * never contain content, cursors or authoritative state. */
export class EveWorldStream extends StreamDO {
  #notifyReaders() {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue
      // A disconnected subscriber cannot turn an already committed append
      // into a retryable write failure.
      try { socket.send('changed') } catch { socket.close(1011, 'Subscription unavailable') }
    }
  }

  async writeChunk(chunk) {
    try {
      const index = await super.writeChunk(chunk)
      this.#notifyReaders()
      return index
    } catch (error) {
      // WDK can retry a terminal flush after another writer committed EOF.
      // The first EOF remains authoritative for live reads and cursor replay.
      if (error?.message !== 'Cannot write to a closed stream') throw error
      const { done, tailIndex } = await super.getInfo()
      if (!done) throw error
      return tailIndex
    }
  }

  async closeStream() {
    await super.closeStream()
    this.#notifyReaders()
  }

  fetch(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || new URL(request.url).pathname !== '/changes') {
      return new Response(null, { status: 404 })
    }
    const id = new URL(request.url).searchParams.get('subscriber')
    if (!validSubscriber(id)) return new Response(null, { status: 400 })
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], [id])
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  release(id) {
    if (!validSubscriber(id)) throw new TypeError('Invalid subscription')
    for (const socket of this.ctx.getWebSockets(id)) {
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'Reader released')
    }
  }

  webSocketClose(socket) { socket.close(1000) }
}

const validSubscriber = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)

async function liveChunks(stub, start, signal, subscriptionId) {
  if (!Number.isSafeInteger(start)) throw new RangeError('Invalid stream index')
  signal?.throwIfAborted()
  let cursor = start < 0 ? Math.max(0, (await stub.getInfo()).tailIndex + 1 + start) : start
  let firstPage = await stub.getChunks({ startIndex: cursor, limit: batchSize })
  signal?.throwIfAborted()
  let socket
  if (!firstPage.done) {
    const response = await stub.fetch('https://stream.internal/changes?subscriber=' + subscriptionId, { headers: { upgrade: 'websocket' } })
    socket = response.webSocket
    if (!socket) throw new Error('Cloudflare stream subscription unavailable')
    // An append or close can race subscription. After an empty first page,
    // read from the same cursor again before waiting for a wake.
    if (!firstPage.chunks.length) firstPage = undefined
  }
  let revision = 0
  let wake
  let closed = false
  let released = false
  const changed = () => { revision++; wake?.() }
  const disconnected = (event) => {
    // Node's explicit DELETE closes the tagged subscriber with 1000/Reader released.
    // That is a clean cancellation, not a missing durable EOF. An unexpected
    // WebSocket close must still fail the byte stream so Eve can recover.
    if (event?.code === 1000 && event.reason === 'Reader released') released = true
    closed = true
    changed()
  }
  const stop = () => {
    released = true
    signal?.removeEventListener('abort', stop)
    disconnected()
    if (socket?.readyState === WebSocket.OPEN) socket.close(1000, 'Reader closed')
  }
  socket?.addEventListener('message', changed)
  socket?.addEventListener('close', disconnected)
  socket?.addEventListener('error', disconnected)
  socket?.accept()
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) { stop(); signal.throwIfAborted() }
  return new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      try {
        while (!closed) {
          const before = revision
          const { chunks, done } = firstPage ?? await stub.getChunks({ startIndex: cursor, limit: batchSize })
          firstPage = undefined
          if (closed) break
          if (chunks.length) {
            cursor += chunks.length
            const nonempty = chunks.filter(chunk => chunk.byteLength > 0)
            for (const chunk of nonempty) controller.enqueue(Uint8Array.from(chunk))
            if (nonempty.length) return
            continue
          }
          if (done) {
            stop()
            controller.close()
            controller.byobRequest?.respond(0)
            return
          }
          if (before === revision) await new Promise(resolve => { wake = resolve })
          wake = undefined
        }
        if (released) {
          controller.close()
          controller.byobRequest?.respond(0)
          return
        }
        throw new Error('Cloudflare stream subscription closed before its durable end')
      } catch (error) {
        stop()
        controller.error(error)
      }
    },
    cancel: stop,
  })
}

function getStreamStub(binding, runId, name) {
  return binding.get(binding.idFromName(JSON.stringify(['stream', runId, name])))
}

function getRunRegistry(binding, runId) {
  return binding.get(binding.idFromName(JSON.stringify(['run-streams', runId])))
}

/** Official v5 Streamer methods carry a run id on every operation. Scope the
 * stream object itself to that run, even if another run uses the same name. */
export function createStreamStorage(binding, { signal, subscriptionId } = {}) {
  async function writable(runId, name) {
    await getRunRegistry(binding, runId).registerStream(name)
    return getStreamStub(binding, runId, name)
  }
  return {
    async write(runId, name, chunk) {
      const stub = await writable(runId, name)
      await stub.writeChunk(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
    },
    async close(runId, name) {
      const stub = await writable(runId, name)
      await stub.closeStream()
    },
    get(runId, name, startIndex = 0) {
      return liveChunks(getStreamStub(binding, runId, name), startIndex, signal, subscriptionId ?? crypto.randomUUID())
    },
    list(runId) {
      return getRunRegistry(binding, runId).listStreams()
    },
    getInfo(runId, name) {
      return getStreamStub(binding, runId, name).getInfo()
    },
    async getChunks(runId, name, { cursor, limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid stream page size')
      const start = cursor == null ? 0 : Number(cursor)
      if (!Number.isSafeInteger(start) || start < 0 || (cursor != null && String(start) !== cursor)) {
        throw new RangeError('Invalid stream cursor')
      }
      const { chunks, done, tailIndex } = await getStreamStub(binding, runId, name).getChunks({ startIndex: start, limit })
      const next = start + chunks.length
      const hasMore = next <= tailIndex
      return { data: chunks.map((data, offset) => ({ index: start + offset, data })), done, hasMore,
        cursor: hasMore ? String(next) : null }
    },
  }
}

/** Node's World transport explicitly releases a tagged subscription through
 * the same private service binding as its read. A TCP disconnect may otherwise
 * be invisible at an idle Worker while no application bytes are being sent. */
export async function serveStreamRequest(request, binding) {
  const { pathname, searchParams } = new URL(request.url)
  const runId = searchParams.get('runId')
  const name = searchParams.get('name')
  if (!runId || !name || runId.length > 256 || name.length > 512) return new Response(null, { status: 400 })
  const id = searchParams.get('subscriber')
  if (pathname !== '/world/stream' || !validSubscriber(id)) return new Response(null, { status: 400 })
  if (request.method === 'DELETE') {
    await getStreamStub(binding, runId, name).release(id)
    return new Response(null, { status: 204 })
  }
  if (request.method !== 'GET') return new Response(null, { status: 405 })
  const value = searchParams.get('start') ?? '0'
  const start = Number(value)
  if (!Number.isSafeInteger(start) || String(start) !== value) return new Response(null, { status: 400 })
  const streams = createStreamStorage(binding, { signal: request.signal, subscriptionId: id })
  const body = await streams.get(runId, name, start)
  return new Response(body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store, no-transform' } })
}
