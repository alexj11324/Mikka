import { EveWorldStream, createStreamStorage, serveStreamRequest } from '../src/streams.mjs'

export class MeasuredStream extends EveWorldStream {
  reads = 0
  rejectSubscriptions = false
  disableSubscriptions() { this.rejectSubscriptions = true }
  fetch(request) {
    if (this.rejectSubscriptions) return new Response(null, { status: 503 })
    return super.fetch(request)
  }
  async getChunks(query) {
    this.reads++
    return super.getChunks(query)
  }
  stats() { return { reads: this.reads, waiting: this.ctx.getWebSockets().filter(socket => socket.readyState === WebSocket.OPEN).length } }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/world/')) return serveStreamRequest(request, env.STREAM)
    const run = url.searchParams.get('run')
    const name = url.searchParams.get('name')
    const streams = createStreamStorage(env.STREAM, { signal: request.signal })
    switch (url.pathname) {
      case '/write': await streams.write(run, name, new Uint8Array(await request.arrayBuffer())); break
      case '/close': await streams.close(run, name); break
      case '/read': return new Response(await streams.get(run, name, Number(url.searchParams.get('start') ?? 0)), {headers: {'content-type':'application/octet-stream','cache-control':'no-transform'}})
      case '/list': return Response.json(await streams.list(run))
      case '/info': return Response.json(await streams.getInfo(run, name))
      case '/chunks': {
        const page = await streams.getChunks(run, name, { limit: Number(url.searchParams.get('limit') ?? 100),
          cursor: url.searchParams.get('cursor') ?? undefined })
        return Response.json({ ...page, data: page.data.map(({ data, index }) => ({ index, bytes: Array.from(data) })) })
      }
      case '/disable-subscriptions': await env.STREAM.getByName(JSON.stringify(['stream', run, name])).disableSubscriptions(); break
      case '/stats': return Response.json(await env.STREAM.getByName(JSON.stringify(['stream', run, name])).stats())
      default: return new Response(null, { status: 404 })
    }
    return new Response(null, { status: 204 })
  },
}
