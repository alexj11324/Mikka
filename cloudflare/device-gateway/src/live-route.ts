import { bearerMatches, deviceGatewayTicketValid } from '../../../lib/device-gateway-ticket'
import { LIVE_CHANNEL, liveInvalidations } from '../../../lib/live/events'
import { liveRevocation } from '../../../lib/live/revocation'
import type { GatewayEnv } from './route'

async function readInvalidations(request: Request) {
  if (Number(request.headers.get('content-length')) > 2048) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const decoder = new TextDecoder()
  let bytes = 0, text = ''
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 2048) { await reader.cancel(); return null }
      text += decoder.decode(part.value, { stream: true })
    }
    const value: unknown = JSON.parse(text + decoder.decode())
    return liveRevocation(value) ? value : liveInvalidations(value, true)
  } catch { return null }
}

/** The same binding, with a non-colliding owner/workspace name and ticket domain. */
export async function handleLiveRequest(request: Request, env: GatewayEnv): Promise<Response> {
  const match = new URL(request.url).pathname.match(/^\/v1\/live\/([^/]+)\/(socket|push)$/)
  if (!match) return new Response(null, { status: 404 })
  const channel = match[1]
  if (!LIVE_CHANNEL.test(channel)) return new Response(null, { status: 400 })
  const name = `live:${channel}`
  const secret = env.GATEWAY_PUSH_SECRET ?? ''
  if (match[2] === 'push') {
    if (request.method !== 'POST' || !bearerMatches(request.headers.get('authorization'), secret)) return new Response(null, { status: 401 })
    const events = await readInvalidations(request)
    if (!events) return new Response(null, { status: 400 })
    if (liveRevocation(events)) {
      await env.DEVICE_SESSION.getByName(name).revokeLive()
      return Response.json({ revoked: true })
    }
    await env.DEVICE_SESSION.getByName(name).notifyLive(events)
    return new Response(null, { status: 204 })
  }
  if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 })
  const offered = request.headers.get('sec-websocket-protocol') ?? ''
  if (!deviceGatewayTicketValid(name, offered, secret)) return new Response(null, { status: 401 })
  const protocol = offered.split(',').map(value => value.trim()).find(value => value.startsWith('mikka-ticket-'))!
  const upgrade = new Request(request)
  upgrade.headers.set('sec-websocket-protocol', protocol)
  return env.DEVICE_SESSION.getByName(name).fetch(upgrade)
}
