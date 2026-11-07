import { createHash } from 'node:crypto'
import { deviceGatewayTicket } from '../device-gateway-ticket'
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
  const channel = liveChannelId(scope)
  const url = gatewayURL(config, `/v1/live/${channel}/socket`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (config.mode === 'builtin') return { url: url.href, ...sessionLiveTicket(channel, sessionId ?? '', config.secret, now) }
  const ticket = deviceGatewayTicket(`live:${channel}`, config.secret, now)
  return { url: url.href, protocol: ticket.protocol, expiresAt: ticket.exp * 1000 }
}
