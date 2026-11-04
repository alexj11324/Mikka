import { createHmac, timingSafeEqual } from 'node:crypto'

/** A connect ticket lasts long enough to open the socket, not to stay online. */
export const DEVICE_GATEWAY_TICKET_SECONDS = 300
const PREFIX = 'mikka-ticket-'

/** Signed connect ticket. The socket carries it as a WebSocket protocol, never in the URL. */
export function deviceGatewayTicket(deviceId: string, secret: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + DEVICE_GATEWAY_TICKET_SECONDS
  const mac = createHmac('sha256', secret).update(`${deviceId}.${exp}`).digest('hex')
  return { exp, protocol: `${PREFIX}${exp}-${mac}` }
}

export function bearerMatches(header: string | null, secret: string) {
  const got = header ?? ''
  const want = `Bearer ${secret}`
  if (!secret || got.length !== want.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(want))
}

/** Accepts the protocol the daemon offered. Expired or swapped device ids fail. */
export function deviceGatewayTicketValid(deviceId: string, protocolHeader: string, secret: string, now = Date.now()) {
  if (!secret) return false
  const offered = protocolHeader.split(',').map(item => item.trim()).find(item => item.startsWith(PREFIX))
  if (!offered) return false
  const body = offered.slice(PREFIX.length)
  const split = body.lastIndexOf('-')
  const exp = body.slice(0, split)
  const mac = body.slice(split + 1)
  if (!/^[0-9]+$/.test(exp) || !/^[a-f0-9]{64}$/.test(mac)) return false
  if (Number(exp) * 1000 <= now) return false
  const expected = createHmac('sha256', secret).update(`${deviceId}.${exp}`).digest('hex')
  const left = Buffer.from(mac)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
