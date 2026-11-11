import { bearerMatches, deviceGatewayTicketValid } from '../../../lib/device-gateway-ticket'
import type { LiveInvalidation } from '../../../lib/live/events'
import { handleLiveRequest } from './live-route'
import type { DevicePresenceWatch } from './session'

export interface DeviceSessionStub {
  notify(): Promise<void>
  notifyLive(events: LiveInvalidation[]): Promise<void>
  revokeLive(): Promise<void>
  status(): Promise<{ online: boolean; lastSeenAt: string | null }>
  fetch(request: Request): Promise<Response>
  watchPresence(input: DevicePresenceWatch): Promise<{ accepted: boolean; changed: boolean }>
  unwatchPresence(observer: string): Promise<void>
  presenceChanged(observers: string[], home: string): Promise<string[]>
}

export interface GatewayEnv {
  DEVICE_SESSION: { getByName(name: string): DeviceSessionStub }
  GATEWAY_PUSH_SECRET?: string
}

const DEVICE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One Durable Object per device (`getByName(deviceId)`). Push carries no work
 * text. The socket upgrade is checked here so a bad ticket never wakes a session
 * that would then read anything.
 */
export async function handleRequest(request: Request, env: GatewayEnv): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname.startsWith('/v1/live/')) return handleLiveRequest(request, env)
  const match = url.pathname.match(/^\/v1\/devices\/([^/]+)\/(socket|push|status)$/)
  if (!match) return new Response(null, { status: 404 })
  const deviceId = decodeURIComponent(match[1] ?? '')
  if (!DEVICE.test(deviceId)) return new Response(null, { status: 400 })
  const secret = env.GATEWAY_PUSH_SECRET ?? ''
  if (match[2] === 'status') {
    if (request.method !== 'GET' || !bearerMatches(request.headers.get('authorization'), secret))
      return new Response(null, { status: 401 })
    return Response.json(await env.DEVICE_SESSION.getByName(deviceId).status(), {
      headers: { 'cache-control': 'no-store' },
    })
  }
  if (match[2] === 'push') {
    if (request.method !== 'POST' || !bearerMatches(request.headers.get('authorization'), secret))
      return new Response(null, { status: 401 })
    await env.DEVICE_SESSION.getByName(deviceId).notify()
    return new Response(null, { status: 204 })
  }
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 })
  const offered = request.headers.get('sec-websocket-protocol') ?? ''
  if (!deviceGatewayTicketValid(deviceId, offered, secret))
    return new Response(null, { status: 401 })
  // The validator checks the first ticket in the offered protocol list. Pass
  // only that authenticated token to the DO: a 101 must select one protocol,
  // not echo a comma-separated list supplied by the client.
  const protocol = offered.split(',').map(item => item.trim()).find(item => item.startsWith('mikka-ticket-'))!
  const upgrade = new Request(request)
  upgrade.headers.set('sec-websocket-protocol', protocol)
  return env.DEVICE_SESSION.getByName(deviceId).fetch(upgrade)
}
