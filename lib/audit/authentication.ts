import 'server-only'
import { APIError } from 'better-auth'
import { and, asc, eq } from 'drizzle-orm'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { enqueueWorkspaceAudit } from './delivery'
import { auditRequestContext, type AuditEvent } from './events'
import { auditFailureSummary } from './record'

type AuthAuditContext = {
  path?: string
  body?: { email?: unknown }
  headers?: Headers
  request?: Request
  context: {
    returned?: unknown
    newSession?: { user: { id: string }; session: { id: string; token: string } } | null
    responseHeaders?: Headers
    internalAdapter: { deleteSession(token: string): Promise<unknown> }
  }
}

/** Called by the existing Better Auth after hook, before publishing its result. */
export async function auditAuthentication(ctx: AuthAuditContext) {
  const method = ctx.path === '/sign-in/email' ? 'password'
    : ctx.path?.startsWith('/callback/') || ctx.path === '/oauth-proxy-callback' ? 'oauth' : null
  if (!method) return
  const session = ctx.context.newSession
  const failure = ctx.context.returned instanceof APIError && ctx.context.returned.statusCode >= 400 && ctx.context.returned.statusCode < 500
  if (!session && (!failure || method !== 'password' || typeof ctx.body?.email !== 'string' || ctx.body.email.length > 320)) return
  try {
    // A failed request supplies only an attempted account, never its actor or tenant.
    const { rows: [user] } = session
      ? await pool.query<{ id: string; name: string }>('SELECT id,name FROM "user" WHERE id=$1', [session.user.id])
      : await pool.query<{ id: string; name: string }>('SELECT id,name FROM "user" WHERE lower(email)=lower($1)', [ctx.body!.email])
    if (!user) return // Unknown accounts have no verified tenant to export an event to.
    const action = session ? 'auth.signed_in' : 'auth.sign_in_failed'
    const event = {
      actor: session ? { type: 'user' as const, id: user.id, name: user.name } : { type: 'system' as const },
      action, target: session ? { type: 'session', id: session.session.id } : { type: 'user', id: user.id },
      metadata: session ? { method } : { method, reason: ctx.context.returned instanceof APIError && ctx.context.returned.statusCode === 401 ? 'invalid' : 'denied' },
      ...auditRequestContext(ctx.headers ?? ctx.request?.headers ?? new Headers()),
    } satisfies Omit<AuditEvent, 'workspaceId'>
    await workspaceDb.transaction(async tx => {
      const memberships = await tx.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers)
        .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active')))
        .orderBy(asc(workspaceMembers.workspaceId)).for('share')
      for (const { workspaceId } of memberships) await enqueueWorkspaceAudit(tx, { ...event, workspaceId })
    })
  } catch (error) {
    console.error('[audit] authentication intent unavailable', auditFailureSummary(error))
    if (!session) return // Preserve the authentication refusal, including unknown-account parity.
    // Never return a bearer/cookie for a sign-in whose audit intent did not commit.
    ctx.context.responseHeaders?.delete('set-cookie')
    ctx.context.newSession = null
    try { await ctx.context.internalAdapter.deleteSession(session.session.token) }
    catch (cleanupError) { console.error('[audit] withheld authentication session cleanup pending', auditFailureSummary(cleanupError)) }
    throw new APIError('SERVICE_UNAVAILABLE', { code: 'AUTH_AUDIT_UNAVAILABLE', message: 'Sign-in unavailable' })
  }
}
