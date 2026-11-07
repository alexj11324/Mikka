import { createHash } from 'node:crypto'
import { deviceGatewayTicket } from '../device-gateway-ticket'
import { gatewayConfig, gatewayURL } from '../builtin-gateway/config'

export type LiveScope = { ownerId: string; workspaceId: string }

/** Both dimensions are signed; a person's other workspaces are different channels. */
export function liveChannelId(scope: LiveScope) {
  return createHash('sha256').update(JSON.stringify([scope.ownerId, scope.workspaceId])).digest('hex')
}

export function liveGatewayConfig(env: Record<string, string | undefined>) {
  const config = gatewayConfig(env)
  return config ? { url: config.url, secret: config.secret } : null
}

export function liveTicket(scope: LiveScope, config: NonNullable<ReturnType<typeof liveGatewayConfig>>, now = Date.now()) {
  const channel = liveChannelId(scope)
  const ticket = deviceGatewayTicket(`live:${channel}`, config.secret, now)
  const url = gatewayURL(config, `/v1/live/${channel}/socket`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return { url: url.href, protocol: ticket.protocol, expiresAt: ticket.exp * 1000 }
}
