// Only the host-supplied configuration enables this relay. The container has
// no network interface; it forwards bytes to its single mounted egress socket.
import { createServer, request } from 'node:http'

export async function startNativeEgress(socketPath = '/run/mikka-egress.sock') {
  const sockets = new Set()
  const track = socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    return socket
  }
  const server = createServer({ maxHeaderSize: 16384 }, (incoming, response) => {
    const outgoing = request({ socketPath, path: incoming.url, method: incoming.method, headers: incoming.headers, agent: false }, upstream => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers)
      upstream.pipe(response)
    })
    outgoing.on('socket', track)
    outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
    incoming.once('aborted', () => outgoing.destroy())
    response.once('close', () => outgoing.destroy())
    incoming.pipe(outgoing)
  })
  server.on('connection', track)
  server.on('connect', (incoming, client, head) => {
    const outgoing = request({ socketPath, method: 'CONNECT', path: incoming.url, headers: { host: incoming.url }, agent: false })
    outgoing.on('socket', track)
    outgoing.on('connect', (response, upstream, upstreamHead) => {
      if (response.statusCode !== 200) { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); upstream.destroy(); return }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (upstreamHead.length) client.write(upstreamHead)
      if (head.length) upstream.write(head)
      upstream.pipe(client);client.pipe(upstream)
      client.once('close', () => upstream.destroy())
      upstream.once('close', () => client.destroy())
    })
    outgoing.on('error', () => client.destroy())
    client.once('close', () => outgoing.destroy())
    outgoing.end()
  })
  server.on('upgrade', (_request, socket) => socket.destroy())
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(0, '127.0.0.1', resolve) })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
