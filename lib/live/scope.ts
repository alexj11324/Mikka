import { createHash } from 'node:crypto'
import { deviceGatewayTicket } from '../device-gateway-ticket'

export type LiveScope = { ownerId: string; workspaceId: string }

/** Both dimensions are signed; a person's other workspaces are different channels. */
export function liveChannelId(scope: LiveScope) {
  return createHash('sha256').update(JSON.stringify([scope.ownerId, scope.workspaceId])).digest('hex')
}

export function liveGatewayConfig(env: Record<string, string | undefined>) {
  if (!env.DEVICE_GATEWAY_URL || !env.DEVICE_GATEWAY_PUSH_SECRET) return null
  try {
    const url = new URL(env.DEVICE_GATEWAY_URL)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    return { url: url.origin, secret: env.DEVICE_GATEWAY_PUSH_SECRET }
  } catch { return null }
}

export function liveTicket(scope: LiveScope, config: NonNullable<ReturnType<typeof liveGatewayConfig>>, now = Date.now()) {
  const channel = liveChannelId(scope)
  const ticket = deviceGatewayTicket(`live:${channel}`, config.secret, now)
  const url = new URL(`/v1/live/${channel}/socket`, config.url)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return { url: url.href, protocol: ticket.protocol, expiresAt: ticket.exp * 1000 }
}
