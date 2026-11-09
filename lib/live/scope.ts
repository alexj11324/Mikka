import { createHash } from 'node:crypto'
import { deviceGatewayTicket, DEVICE_GATEWAY_TICKET_SECONDS } from '../device-gateway-ticket'
import { gatewayConfig, gatewayURL } from '../builtin-gateway/config'
import { sessionLiveTicket } from './session-ticket'

export type LiveScope = { ownerId: string; workspaceId: string }

/** Both dimensions are signed; a person's other workspaces are different channels. */
export function liveChannelId(scope: LiveScope) {
  return createHash('sha256').update(JSON.stringify([scope.ownerId, scope.workspaceId])).digest('hex')
}

export function liveGatewayConfig(env: Record<string, string | undefined>) {
  const config = gatewayConfig(env)
  return config ? { url: config.url, secret: config.secret, mode: config.mode } : null
}

export function liveTicket(scope: LiveScope, config: { url: string; secret: string; mode?: 'builtin' | 'worker' }, now = Date.now(), sessionId?: string) {
  return liveChannelTicket(liveChannelId(scope), config, now, sessionId)
}

/** A capability channel is opaque to clients; device execution tickets and
 * the existing browser wire formats are unchanged. */
export function liveChannelTicket(channel: string, config: { url: string; secret: string; mode?: 'builtin' | 'worker' }, now = Date.now(), sessionId?: string, expiresAt?: number) {
  const url = gatewayURL(config, `/v1/live/${channel}/socket`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (config.mode === 'builtin') return { url: url.href, ...sessionLiveTicket(channel, sessionId ?? '', config.secret, now, expiresAt) }
  const ticketNow = expiresAt === undefined ? now : Math.min(now, expiresAt - DEVICE_GATEWAY_TICKET_SECONDS * 1000)
  const ticket = deviceGatewayTicket(`live:${channel}`, config.secret, ticketNow)
  return { url: url.href, protocol: ticket.protocol, expiresAt: ticket.exp * 1000 }
}
