// Browser-only outbound proxy. E2B forwards loopback TCP ports, so reject
// connections unless the kernel attributes the client socket to the browser
// account. The root-owned process checks /proc for the exact live TCP tuple.
// Resolve once and connect to the checked IPv4 address: a DNS rebinding cannot
// replace it between validation and connection. Every redirect and subresource
// is independently checked because Chromium sends it through this proxy.
import { createServer, request as httpRequest } from 'node:http'
import { connect, createServer as createTcpServer, isIP } from 'node:net'
import { resolve4 } from 'node:dns/promises'
import { readFileSync } from 'node:fs'

const browserUid = Number(process.env.MIKKA_BROWSER_UID)
if (!Number.isSafeInteger(browserUid) || browserUid < 1) throw new Error('Browser identity unavailable')
function authorizedPeer(socket) {
  if (socket.remoteAddress !== '127.0.0.1' || !socket.remotePort || socket.localAddress !== '127.0.0.1') return false
  const client = `0100007F:${socket.remotePort.toString(16).toUpperCase().padStart(4, '0')}`
  const listener = `0100007F:${socket.localPort.toString(16).toUpperCase().padStart(4, '0')}`
  try {
    return readFileSync('/proc/net/tcp', 'utf8').split('\n').some(line => {
      const fields = line.trim().split(/\s+/)
      return fields[1] === client && fields[2] === listener && fields[3] === '01' && Number(fields[7]) === browserUid
    })
  } catch { return false }
}

function publicIPv4(address) {
  if (isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
}
async function destination(hostname, port) {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host || isIP(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || ![80, 443].includes(Number(port))) throw new Error('Address unavailable')
  const ips = await resolve4(host)
  if (!ips.length || ips.some(ip => !publicIPv4(ip))) throw new Error('Address unavailable')
  return ips[0]
}
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url)
    if (url.protocol !== 'http:' || url.username || url.password) throw new Error('Address unavailable')
    const port = Number(url.port || 80), address = await destination(url.hostname, port)
    const headers = { ...incoming.headers, host: url.host }
    delete headers['proxy-authorization']; delete headers['proxy-connection']
    const upstream = httpRequest({ host: address, port, path: `${url.pathname}${url.search}`, method: incoming.method, headers }, response => {
      outgoing.writeHead(response.statusCode || 502, response.headers); response.pipe(outgoing)
    })
    upstream.setTimeout(30_000, () => upstream.destroy())
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end() })
    incoming.pipe(upstream)
  } catch { outgoing.writeHead(403); outgoing.end() }
})
server.on('connect', async (incoming, client, head) => {
  try {
    const match = /^([^:]+):(\d+)$/.exec(incoming.url || '')
    if (!match) throw new Error('Address unavailable')
    const address = await destination(match[1], Number(match[2]))
    const upstream = connect({ host: address, port: Number(match[2]) })
    upstream.setTimeout(30_000, () => upstream.destroy())
    upstream.on('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client) })
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy())
  } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') }
})
server.on('clientError', (_, socket) => socket.destroy())
createTcpServer({ pauseOnConnect: true }, socket => {
  if (!authorizedPeer(socket)) { socket.destroy(); return }
  server.emit('connection', socket)
  socket.resume()
}).listen(6082, '127.0.0.1')
