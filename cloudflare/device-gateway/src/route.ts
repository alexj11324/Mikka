import { bearerMatches, deviceGatewayTicketValid } from '../../../lib/device-gateway-ticket'

export interface DeviceSessionStub {
  notify(): Promise<void>
  fetch(request: Request): Promise<Response>
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
  const match = url.pathname.match(/^\/v1\/devices\/([^/]+)\/(socket|push)$/)
  if (!match) return new Response(null, { status: 404 })
  const deviceId = decodeURIComponent(match[1] ?? '')
  if (!DEVICE.test(deviceId)) return new Response(null, { status: 400 })
  const secret = env.GATEWAY_PUSH_SECRET ?? ''
  if (match[2] === 'push') {
    if (request.method !== 'POST' || !bearerMatches(request.headers.get('authorization'), secret))
      return new Response(null, { status: 401 })
    await env.DEVICE_SESSION.getByName(deviceId).notify()
    return new Response(null, { status: 204 })
  }
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 })
  if (!deviceGatewayTicketValid(deviceId, request.headers.get('sec-websocket-protocol') ?? '', secret))
    return new Response(null, { status: 401 })
  return env.DEVICE_SESSION.getByName(deviceId).fetch(request)
}
