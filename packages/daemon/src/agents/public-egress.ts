import { lookup } from 'node:dns/promises'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { connect, isIP, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPublicWebAddress } from '@mikka/protocol/web-url-policy'

export type EgressDestination = { host: string; port: number }
export type EgressAddress = { address: string; family: number }
export type EgressResolver = (host: string) => Promise<EgressAddress[]>
const resolveHost: EgressResolver = host => lookup(host, { all: true, verbatim: true })

/** Validate the complete DNS answer and connect to one of THESE IPs. Never
 * validate one lookup and let a downstream client resolve the name again. */
export async function resolvePublicDestination(host: string, resolver: EgressResolver = resolveHost): Promise<EgressAddress> {
  if (!host || host.length > 253 || /[\s\x00-\x1f\x7f%\\/@?#*]/u.test(host)) throw new Error('egressDestinationDenied')
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(bare)) throw new Error('egressDestinationDenied')
  const family = isIP(bare)
  const addresses = family ? [{ address: bare, family }] : await resolver(bare)
  if (!addresses.length || addresses.some(row => ![4, 6].includes(row.family) || isIP(row.address) !== row.family || !isPublicWebAddress(row.address))) throw new Error('egressDestinationDenied')
  return addresses[0]
}

/** Forward explicit HTTP requests and opaque CONNECT tunnels only. No cookies,
 * cloud credentials or provider tokens are injected by the host. */
export function egressDestination(value: string, tunnel: boolean): EgressDestination & { url: URL } {
  if (value.length > 16_384 || /[\x00-\x20\x7f\\]/u.test(value)) throw new Error('egressDestinationDenied')
  const url = new URL(tunnel ? `http://${value}` : value)
  if (url.username || url.password || url.hash || !url.hostname || url.protocol !== 'http:') throw new Error('egressDestinationDenied')
  if (tunnel && (url.pathname !== '/' || url.search || !/:[1-9][0-9]{0,4}$/.test(value))) throw new Error('egressDestinationDenied')
  const port = Number(url.port || 80)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('egressDestinationDenied')
  return { host: url.hostname, port, url }
}

function endToEndHeaders(input: IncomingHttpHeaders): IncomingHttpHeaders {
  const headers = { ...input }
  const connection = String(headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())
  for (const key of [...connection, 'connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete headers[key]
  return headers
}

export interface PublicEgress {
  socketPath: string
  close(): Promise<void>
}
export interface PublicEgressOptions {
  authorize(destination: EgressDestination, signal: AbortSignal): Promise<boolean>
  signal: AbortSignal
}

/** One private Unix socket per run. The container keeps --network=none; only
 * this owned endpoint crosses that boundary. Revocation tears down established
 * connections as well as pending requests, not just the next tool call. */
export async function startPublicEgress(options: PublicEgressOptions): Promise<PublicEgress> {
  options.signal.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'mikka-egress-'))
  await chmod(directory, 0o700)
  const socketPath = join(directory, 'egress.sock')
  const lifetime = new AbortController()
  const signal = AbortSignal.any([options.signal, lifetime.signal])
  const sockets = new Set<Socket>()
  const track = (socket: Socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
    socket.setTimeout(120_000, () => socket.destroy())
    return socket
  }
  async function admit(destination: EgressDestination) {
    signal.throwIfAborted()
    if (!await options.authorize(destination, signal)) throw new Error('egressDenied')
    const address = await resolvePublicDestination(destination.host)
    signal.throwIfAborted()
    // Current authority can change during DNS resolution.
    if (!await options.authorize(destination, signal)) throw new Error('egressDenied')
    signal.throwIfAborted()
    return address
  }
  const server = createServer({ maxHeaderSize: 16_384, headersTimeout: 15_000, requestTimeout: 300_000 }, (request, response) => {
    void (async () => {
      const destination = egressDestination(request.url ?? '', false)
      const address = await admit(destination)
      if (request.destroyed || response.destroyed) return
      const headers = endToEndHeaders(request.headers)
      headers.host = destination.url.host
      const upstream = httpRequest({
        hostname: address.address, family: address.family, port: destination.port,
        method: request.method, path: destination.url.pathname + destination.url.search,
        headers, agent: false, signal,
      }, result => {
        response.writeHead(result.statusCode ?? 502, endToEndHeaders(result.headers))
        result.pipe(response)
      })
      upstream.on('socket', track)
      upstream.setTimeout(120_000, () => upstream.destroy())
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
      request.once('aborted', () => upstream.destroy())
      response.once('close', () => upstream.destroy())
      request.pipe(upstream)
    })().catch(() => { if (!response.destroyed) { response.writeHead(403); response.end() } })
  })
  server.on('connection', socket => {
    if (signal.aborted || sockets.size >= 256) { socket.destroy(); return }
    track(socket)
  })
  server.on('connect', (request, client, head) => {
    void (async () => {
      const destination = egressDestination(request.url ?? '', true)
      const address = await admit(destination)
      if (client.destroyed) return
      const upstream = track(connect({ host: address.address, family: address.family, port: destination.port }))
      const timer = setTimeout(() => { upstream.destroy(); client.destroy() }, 15_000)
      upstream.once('connect', () => {
        clearTimeout(timer)
        if (signal.aborted || client.destroyed) { upstream.destroy(); client.destroy(); return }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream); upstream.pipe(client)
      })
      upstream.once('error', () => { clearTimeout(timer); client.destroy() })
      upstream.once('close', () => { clearTimeout(timer); client.destroy() })
      client.once('close', () => upstream.destroy())
    })().catch(() => { if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') })
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('upgrade', (_request, socket) => socket.destroy())
  let closing: Promise<void> | undefined
  const close = () => {
    if (closing) return closing
    lifetime.abort()
    for (const socket of sockets) socket.destroy()
    closing = new Promise<void>((resolve, reject) => server.close(error => {
      options.signal.removeEventListener('abort', onAbort)
      void rm(directory, { recursive: true, force: true }).then(() => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve(), reject)
    }))
    return closing
  }
  const onAbort = () => { void close().catch(() => undefined) }
  options.signal.addEventListener('abort', onAbort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve() })
    })
    await chmod(socketPath, 0o600)
    signal.throwIfAborted()
    return { socketPath, close }
  } catch (error) { await close(); throw error }
}
