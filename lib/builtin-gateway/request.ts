import { bearerMatches, deviceGatewayTicketValid } from '../device-gateway-ticket'
import { LIVE_CHANNEL, LIVE_ID, LIVE_REVISION_PARAM, liveInvalidations } from '../live/events'
import { LIVE_PRESENCE_PARAM } from '../live/presence'
import { readSessionLiveTicket } from '../live/session-ticket'
import { liveRevocation } from '../live/revocation'
import { builtinGatewayConfig } from './config'
import type { GatewayHub, GatewaySocket } from './hub'

type Environment = Readonly<Record<string, string | undefined>>

function target(request: Request, env: Environment) {
  const config = builtinGatewayConfig(env)
  if (!config) return null
  const url = new URL(request.url)
  const configured = new URL(config.url)
  // A TLS reverse proxy can supply HTTP to Node. Only the explicitly
  // configured Host is authoritative; arbitrary forwarded hosts are ignored.
  if (url.host !== configured.host || (request.headers.get('host') && request.headers.get('host') !== configured.host)) return null
  const match = /^\/mikka\/v1\/(live|devices)\/([^/]+)\/(socket|push|status)$/.exec(url.pathname)
  if (!match) return null
  const kind = match[1] === 'live' ? 'live' : 'device'
  const key = match[2]
  if (!(kind === 'live' ? LIVE_CHANNEL : LIVE_ID).test(key) || kind === 'live' && match[3] === 'status') return null
  return { config, url, kind, key, operation: match[3] } as const
}

export function gatewayUpgrade(request: Request, env: Environment = process.env, now = Date.now()): { protocol: string; socket: GatewaySocket } | Response {
  const found = target(request, env)
  if (!found || found.operation !== 'socket') return new Response(null, { status: 404 })
  if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 })
  const offered = request.headers.get('sec-websocket-protocol') ?? ''
  if (found.kind === 'live') {
    // Built-in live never accepts an unbound legacy ticket. Worker and device
    // protocols are unchanged; all browser/native clients pass this opaque value through.
    const ticket = readSessionLiveTicket(found.key, offered, found.config.secret, now)
    if (!ticket) return new Response(null, { status: 401 })
    return { protocol: ticket.protocol, socket: { kind: 'live', key: found.key, sessionId: ticket.sessionId,
      expiresAt: ticket.expiresAt, revisions: found.url.searchParams.get(LIVE_REVISION_PARAM) === '1',
      ...(found.url.searchParams.get(LIVE_PRESENCE_PARAM) === '1' ? { presence: true } : {}) } }
  }
  if (!deviceGatewayTicketValid(found.key, offered, found.config.secret, now)) return new Response(null, { status: 401 })
  const protocol = offered.split(',').map(item => item.trim()).find(item => item.startsWith('mikka-ticket-'))!
  const expiresAt = Number(protocol.split('-')[2]) * 1000
  return { protocol, socket: { kind: found.kind, key: found.key, expiresAt, revisions: found.url.searchParams.get(LIVE_REVISION_PARAM) === '1' } }
}

export async function gatewayRequest(request: Request, hub: GatewayHub, env: Environment = process.env): Promise<Response> {
  const found = target(request, env)
  if (!found) return new Response(null, { status: 404 })
  if (found.operation === 'socket') return new Response(null, { status: 426 })
  if (!bearerMatches(request.headers.get('authorization'), found.config.secret)) return new Response(null, { status: 401 })
  if (found.operation === 'status' && request.method === 'GET') {
    return Response.json(await hub.status(found.key), { headers: { 'cache-control': 'no-store' } })
  }
  if (found.operation !== 'push' || request.method !== 'POST') return new Response(null, { status: 405 })
  if (found.kind === 'device') await hub.work(found.key)
  else {
    if (Number(request.headers.get('content-length') ?? '0') > 2048) return new Response(null, { status: 400 })
    const reader = request.body?.getReader()
    if (!reader) return new Response(null, { status: 400 })
    const chunks: Uint8Array[] = []
    let size = 0
    let events
    let revoke = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2048) { await reader.cancel(); return new Response(null, { status: 400 }) }
        chunks.push(value)
      }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      revoke = liveRevocation(payload)
      if (!revoke) events = liveInvalidations(payload, true)
    } catch { return new Response(null, { status: 400 }) }
    finally { reader.releaseLock() }
    if (revoke) {
      await hub.revokeLive(found.key)
      return Response.json({ revoked: true })
    }
    if (!events) return new Response(null, { status: 400 })
    await hub.live(found.key, events)
  }
  return new Response(null, { status: 204 })
}
