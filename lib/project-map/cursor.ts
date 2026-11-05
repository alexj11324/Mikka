import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { MapReadError, mapQueryFieldsSchema, type MapQuery } from './read-contracts'
export const MAP_SNAPSHOT_TTL = 10 * 60 * 1000
const claimSchema = z.object({
  version: z.literal(1), kind: z.enum(['snapshot', 'page', 'source']), viewerId: z.string().min(1).max(200),
  workspaceId: z.uuid(), projectId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(), query: mapQueryFieldsSchema.omit({ workspaceId: true, cursor: true, snapshot: true, limit: true }),
  afterOrder: z.number().int().min(-1).optional(), afterId: z.string().max(256).optional(),
  sourceRef: z.string().max(256).optional(), upperBound: z.number().int().min(-1).optional(), offset: z.number().int().nonnegative().optional(),
}).strict()
export type MapClaims = z.infer<typeof claimSchema>
type Scope = { userId: string; workspaceId: string; projectId: string }
export function queryIdentity(query: MapQuery) {
  const { laneLimit, branchId, q, filter, from, to } = query
  return { laneLimit, ...(branchId ? { branchId } : {}), q, filter, ...(from ? { from } : {}), ...(to ? { to } : {}) }
}
export function fingerprint(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function key(secret: string | undefined) {
  if (!secret) throw new MapReadError('map_unavailable', { detail: 'signing_key' })
  return createHmac('sha256', secret).update('project-map-cursor:v1').digest()
}
export function signMapToken(claims: MapClaims, secret = process.env.BETTER_AUTH_SECRET) {
  const parsed = claimSchema.safeParse(claims)
  if (!parsed.success) throw new MapReadError('map_invalid_request', { detail: 'invalid_token', cause: parsed.error })
  const payload = Buffer.from(JSON.stringify(parsed.data)).toString('base64url')
  return payload + '.' + createHmac('sha256', key(secret)).update(payload).digest('base64url')
}
export function readMapToken(token: string, scope: Scope, kinds: MapClaims['kind'][], now = Date.now(), secret = process.env.BETTER_AUTH_SECRET): MapClaims {
  if (token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new MapReadError('map_invalid_request', { detail: 'invalid_token' })
  const [payload, mac] = token.split('.')
  const expected = createHmac('sha256', key(secret)).update(payload).digest(), received = Buffer.from(mac, 'base64url')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new MapReadError('map_invalid_request', { detail: 'invalid_token' })
  let value: unknown
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) }
  catch (cause) { throw new MapReadError('map_invalid_request', { detail: 'invalid_token', cause }) }
  const parsed = claimSchema.safeParse(value)
  if (!parsed.success || !kinds.includes(parsed.data.kind)) throw new MapReadError('map_invalid_request', { detail: 'invalid_token', cause: parsed.success ? undefined : parsed.error })
  const claims = parsed.data
  if (claims.viewerId !== scope.userId || claims.workspaceId !== scope.workspaceId || claims.projectId !== scope.projectId) throw new MapReadError('map_not_found')
  if (claims.expiresAt <= now) throw new MapReadError('map_snapshot_expired')
  return claims
}
export function snapshotClaims(scope: Scope, query: MapQuery, content: string, now = Date.now()): MapClaims {
  return { version: 1, kind: 'snapshot', viewerId: scope.userId, workspaceId: scope.workspaceId,
    projectId: scope.projectId, fingerprint: content, expiresAt: now + MAP_SNAPSHOT_TTL, query: queryIdentity(query) }
}
export function checkSnapshot(claims: MapClaims, content: string, query?: MapQuery) {
  if (claims.fingerprint !== content || query && fingerprint(claims.query) !== fingerprint(queryIdentity(query)))
    throw new MapReadError('map_snapshot_changed', { detail: 'source_changed' })
}
