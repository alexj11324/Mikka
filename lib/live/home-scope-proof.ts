import { createHmac, timingSafeEqual } from 'node:crypto'
import { DEVICE_GATEWAY_TICKET_SECONDS } from '../device-gateway-ticket'
import { LIVE_ID } from './events'
import type { LiveScope } from './scope'

/** A short-lived routing assertion from the live ticket's existing membership
 * read. It grants no content, device, model or socket authority. */
export type HomeScopeProof = LiveScope & { token: string; expiresAt: number }
type HomeScope = LiveScope & { v: 1; expiresAt: number }
const MAX_BYTES = 1024
const signature = (payload: string, secret: string) => createHmac('sha256', secret).update(`mikka-presence-home-v1.${payload}`).digest('hex')

function payload(value: unknown, now: number): HomeScope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4) return null
  const scope = value as Partial<HomeScope>
  return scope.v === 1 && typeof scope.ownerId === 'string' && scope.ownerId.length > 0 && scope.ownerId.length <= 200
    && typeof scope.workspaceId === 'string' && LIVE_ID.test(scope.workspaceId)
    && typeof scope.expiresAt === 'number' && Number.isSafeInteger(scope.expiresAt)
    && scope.expiresAt > now && scope.expiresAt <= now + DEVICE_GATEWAY_TICKET_SECONDS * 1000 + 5000
    ? scope as HomeScope : null
}

/** Only the ticket route's fresh personal-home projection may issue this. */
export function homeScopeProof(scope: LiveScope, expiresAt: number, secret: string, now = Date.now()): HomeScopeProof | null {
  if (!secret || expiresAt > now + DEVICE_GATEWAY_TICKET_SECONDS * 1000) return null
  const valid = payload({ v: 1, ...scope, expiresAt }, now)
  if (!valid) return null
  const encoded = Buffer.from(JSON.stringify(valid)).toString('base64url')
  const token = `${encoded}.${signature(encoded, secret)}`
  return token.length <= MAX_BYTES ? { ownerId: valid.ownerId, workspaceId: valid.workspaceId, expiresAt, token } : null
}

/** The ordinary reader still authenticates the owner and loads owned devices
 * afresh. Missing/invalid routing metadata leaves its data read unchanged. */
export function readHomeScopeProof(token: string, ownerId: string, secret: string, now = Date.now()): (LiveScope & { expiresAt: number }) | null {
  if (!secret || token.length > MAX_BYTES || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) return null
  const [encoded, supplied] = token.split('.')
  if (!timingSafeEqual(Buffer.from(signature(encoded, secret)), Buffer.from(supplied))) return null
  try {
    const valid = payload(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), now)
    return valid?.ownerId === ownerId ? { ownerId, workspaceId: valid.workspaceId, expiresAt: valid.expiresAt } : null
  } catch { return null }
}
