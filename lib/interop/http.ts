import 'server-only'
import { pool } from '@/lib/db'
import { getApiSession } from '@/lib/api-auth'
import type { ApiScope } from '@/lib/tokens/format'
import { InteropError } from './errors'
import { interopFailure } from './tools'
import type { InteropPrincipal } from './principal'
import type { InteropDriveScope } from './drive'

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const BODY_LIMIT = 6 * 1024 * 1024

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers })

function failure(error: unknown): Response {
  const body = interopFailure(error)
  const status = error instanceof InteropError ? error.status : 500
  return json(body, status)
}

/**
 * The `/api/v1` interop principal (decision 2026-11-19-2200 §5): a scoped PAT
 * acts as its owner in the token's Workspace; an `mksvc_` key acts as its
 * service identity, authorized only by that service's grants. A cookie never
 * authenticates `/api/v1`.
 */
export async function interopApiPrincipal(request: Request, scope: ApiScope): Promise<InteropPrincipal | Response> {
  const authorization = request.headers.get('authorization')
  if (/^Bearer\s+mksvc_/i.test(authorization ?? '')) {
    const { authenticateServiceCredential } = await import('@/lib/governance/service-credentials')
    const service = await authenticateServiceCredential(authorization)
    if (!service) return json({ error: 'authRequired' }, 401)
    return { kind: 'service', serviceId: service.serviceIdentityId, workspaceId: service.workspaceId }
  }
  const session = await getApiSession({ headers: request.headers, audience: 'v1' })
  if (!session?.tokenWorkspaceId) return json({ error: 'authRequired' }, 401)
  if (!session.tokenScopes?.includes(scope)) return json({ error: 'interop_scope_required' }, 403)
  return { kind: 'account', userId: session.user.id, workspaceId: session.tokenWorkspaceId }
}

/** One `/api/v1` interop handler: authenticate, run, and map refusals to their codes. */
export async function interopApi(request: Request, scope: ApiScope, work: (principal: InteropPrincipal) => Promise<unknown>, status = 200): Promise<Response> {
  try {
    const principal = await interopApiPrincipal(request, scope)
    if (principal instanceof Response) return principal
    return json(await work(principal), status)
  } catch (error) {
    if (error instanceof InteropError) return failure(error)
    throw error
  }
}

/** A handler only a person's PAT may call, as that person (never a service key). */
export async function accountApi(request: Request, scope: ApiScope, work: (manager: { userId: string; workspaceId: string }) => Promise<unknown>, status = 200): Promise<Response> {
  return interopApi(request, scope, async principal => {
    if (principal.kind !== 'account') throw new InteropError('interop_scope_required')
    return work({ userId: principal.userId, workspaceId: principal.workspaceId })
  }, status)
}

/** A JSON body, bounded; anything else is `interop_invalid_request`. */
export async function interopBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('content-length') ?? '0')
  if (length > BODY_LIMIT) throw new InteropError('interop_invalid_request')
  let text: string
  try { text = await request.text() } catch (error) { throw new InteropError('interop_invalid_request', { cause: error }) }
  if (text.length > BODY_LIMIT) throw new InteropError('interop_invalid_request')
  let value: unknown
  try { value = JSON.parse(text) } catch (error) { throw new InteropError('interop_invalid_request', { cause: error }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InteropError('interop_invalid_request')
  return value as Record<string, unknown>
}

/** The idempotency key of a send: the body's `key`, else the `Idempotency-Key` header. */
export function sendKey(request: Request, body: Record<string, unknown>): unknown {
  return body.key ?? request.headers.get('idempotency-key') ?? undefined
}

/** Optional search parameter, absent when empty. */
export function param(request: Request, name: string): string | undefined {
  return new URL(request.url).searchParams.get(name) || undefined
}

export function limitParam(request: Request): number | undefined {
  const value = param(request, 'limit')
  if (value === undefined) return undefined
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1) throw new InteropError('interop_invalid_request')
  return limit
}

const STORED_TO_SCOPE: Record<string, InteropDriveScope> = { bot: 'bot', thread: 'thread', environment: 'environment', 'team-workspace': 'workspace' }

/** The interop scope of a volume in the principal's tenant; a personal or Project volume is not one. */
export async function volumeScope(principal: InteropPrincipal, volumeId: string): Promise<{ scope: InteropDriveScope; scopeId: string; volumeId: string }> {
  const { rows: [volume] } = await pool.query<{ driveScope: string; scopeId: string }>(
    `SELECT "driveScope","scopeId" FROM drive_volumes WHERE id=$1 AND "workspaceId"=$2 AND "archivedAt" IS NULL
       AND "driveScope" IN ('bot','thread','environment','team-workspace')`, [volumeId, principal.workspaceId])
  const scope = volume && STORED_TO_SCOPE[volume.driveScope]
  if (!scope) throw new InteropError('interop_not_found')
  return { scope, scopeId: volume.scopeId, volumeId }
}
