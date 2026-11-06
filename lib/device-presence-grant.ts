import { createHmac, timingSafeEqual } from 'node:crypto'
import { liveChannelId, type LiveScope } from './live/scope'
import { presenceGrantPayload, PRESENCE_GRANT_MS, PRESENCE_MAX_TOKEN_BYTES, type PresenceDevice, type PresenceProof } from './live/presence'

const signature = (payload: string, secret: string) => createHmac('sha256', secret).update(`mikka-presence-v1.${payload}`).digest('hex')

/** Mint only from rows the ordinary device/thread read already authorized and
 * its resolved personal home. No membership query or heartbeat is added here. */
export function devicePresenceGrant(scope: LiveScope, devices: PresenceDevice[], secret: string, now = Date.now()): PresenceProof | null {
  if (!secret) return null
  const grant = presenceGrantPayload({ channel: liveChannelId(scope), home: scope.workspaceId, expiresAt: now + PRESENCE_GRANT_MS, devices }, now)
  if (!grant) return null
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url')
  const token = `${payload}.${signature(payload, secret)}`
  return token.length <= PRESENCE_MAX_TOKEN_BYTES ? { token, expiresAt: grant.expiresAt } : null
}

/** A valid ticket for this exact owner/home channel is still required before
 * this grant is read. Its separate HMAC domain cannot be used as a socket ticket. */
export function readDevicePresenceGrant(token: string, channel: string, secret: string, now = Date.now()) {
  if (!secret || token.length > PRESENCE_MAX_TOKEN_BYTES || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) return null
  const [payload, supplied] = token.split('.')
  if (!timingSafeEqual(Buffer.from(signature(payload, secret)), Buffer.from(supplied))) return null
  try {
    const grant = presenceGrantPayload(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), now)
    return grant?.channel === channel ? grant : null
  } catch { return null }
}
