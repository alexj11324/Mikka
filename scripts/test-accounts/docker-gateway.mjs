import { request as httpRequest } from 'node:http'
import { EnvironmentError } from './database-target.mjs'

const DEVICE = '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}'
const ROUTE = new RegExp(`^/v1/(?:live/[a-f0-9]{64}/(socket|push)|devices/${DEVICE}/(socket|push|status))$`)

/** The public service reuses the real Worker, including its ticket/secret checks. */
export function dockerGatewayRequest(path, method, upgrade = false) {
  if (typeof path !== 'string') return false
  const query = path.indexOf('?')
  const matched = ROUTE.exec(query < 0 ? path : path.slice(0, query))
  // Both live clients opt into revision messages. No other query capability,
  // duplicate parameter or alternate encoding is accepted by the public proxy.
  if (query >= 0 && (matched?.[1] !== 'socket' || path.slice(query) !== '?revisions=1')) return false
  const operation = matched?.[1] ?? matched?.[2]
  return Boolean(operation && (upgrade ? operation === 'socket' && method === 'GET'
    : operation === 'push' ? method === 'POST' : method === 'GET'))
}

function upstream(request, gateway) {
  const target = new URL(gateway)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new EnvironmentError('DOCKER_GATEWAY_TARGET_FORBIDDEN')
  const headers = { ...request.headers, host: target.host }
  // The Worker receives the original capability, never proxy-origin claims.
  for (const key of ['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-for']) delete headers[key]
  // Miniflare consumes these headers as internal routing/request metadata.
  // Public callers must not override the fixed Worker target or original URL.
  for (const key of Object.keys(headers)) if (key.toLowerCase().startsWith('mf-')) delete headers[key]
  return httpRequest({ hostname: '127.0.0.1', port: target.port, method: request.method, path: request.url, headers })
}

export function proxyDockerGateway(request, response, gateway) {
  if (!dockerGatewayRequest(request.url, request.method)) throw new EnvironmentError('DOCKER_GATEWAY_ROUTE_FORBIDDEN')
  const proxy = upstream(request, gateway)
  proxy.once('response', incoming => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers)
    incoming.pipe(response)
    incoming.once('error', () => response.destroy())
  })
  proxy.once('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
  request.once('aborted', () => proxy.destroy())
  response.once('close', () => proxy.destroy())
  request.pipe(proxy)
}

export function proxyDockerGatewayUpgrade(request, socket, head, gateway) {
  if (!dockerGatewayRequest(request.url, request.method, true)) throw new EnvironmentError('DOCKER_GATEWAY_ROUTE_FORBIDDEN')
  const proxy = upstream(request, gateway)
  proxy.once('upgrade', (response, remote, remoteHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((headers, value, index, values) => index % 2 ? headers : `${headers}${value}: ${values[index + 1]}\r\n`, '')}\r\n`)
    if (remoteHead.length) socket.write(remoteHead)
    if (head.length) remote.write(head)
    remote.once('error', () => socket.destroy())
    socket.once('error', () => remote.destroy())
    socket.once('close', () => remote.destroy())
    remote.once('close', () => socket.destroy())
    socket.pipe(remote).pipe(socket)
  })
  proxy.once('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) })
  proxy.once('error', () => socket.destroy())
  socket.once('close', () => proxy.destroy())
  proxy.end()
}
