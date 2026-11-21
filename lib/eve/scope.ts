import { z } from 'zod'
import type { AuthResult } from 'eve/channels/auth'

export const eveScopeSchema = z.object({
  ownerId: z.string().min(1), botId: z.uuid(), workspaceId: z.uuid(),
  surface: z.enum(['web','slack']).default('web'),
})
export type EveScope = z.infer<typeof eveScopeSchema>

export function scopeAuth(scope: EveScope): AuthResult {
  return { authenticator: 'mikka', principalType: 'user', principalId: scope.ownerId,
    attributes: { botId: scope.botId, workspaceId: scope.workspaceId, surface: scope.surface } }
}

export function scopeFromAuth(auth: AuthResult | null | undefined): EveScope {
  if (auth?.authenticator !== 'mikka' || auth.principalType !== 'user') throw new Error('authRequired')
  return eveScopeSchema.parse({ ownerId: auth.principalId, ...auth.attributes })
}

/** Session ids are routing identities. Mikka's persisted bot/workspace is authority. */
export async function assertEveScope(scope: EveScope) {
  const [{ pool }, { requireTaskWorkspace }] = await Promise.all([import('../db'), import('../task-workspace')])
  const row = await pool.query('SELECT 1 FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [scope.botId, scope.ownerId, scope.workspaceId])
  if (!row.rowCount) throw new Error('botNotFound')
  await requireTaskWorkspace(scope.ownerId, scope.workspaceId)
  return scope
}

export async function registerSession(scope: EveScope, sessionId: string) {
  await assertEveScope(scope)
  const { pool } = await import('../db')
  // The primary key binds a session once. With a matching existing owner,
  // return the verification result without updating its physical PostgreSQL row.
  const row = await pool.query(`WITH existing AS (
      SELECT owner_id=$2 AND bot_id=$3 AND workspace_id=$4 AND surface=$5 AS matches
      FROM eve_sessions WHERE session_id=$1
    ), inserted AS (
      INSERT INTO eve_sessions(session_id,owner_id,bot_id,workspace_id,surface)
      SELECT $1,$2,$3::uuid,$4::uuid,$5 WHERE NOT EXISTS (SELECT 1 FROM existing)
      ON CONFLICT(session_id) DO UPDATE SET session_id=excluded.session_id
      WHERE eve_sessions.owner_id=excluded.owner_id AND eve_sessions.bot_id=excluded.bot_id
        AND eve_sessions.workspace_id=excluded.workspace_id AND eve_sessions.surface=excluded.surface
      RETURNING true
    )
    SELECT 1 FROM existing WHERE matches UNION ALL SELECT 1 FROM inserted`,
  [sessionId, scope.ownerId, scope.botId, scope.workspaceId, scope.surface])
  if (!row.rowCount) throw new Error('workspaceAccessDenied')
}

export async function assertSessionScope(scope: EveScope, sessionId: string) {
  await assertEveScope(scope)
  const { pool } = await import('../db')
  const row = await pool.query(`SELECT 1 FROM eve_sessions WHERE session_id=$1 AND owner_id=$2 AND bot_id=$3 AND workspace_id=$4 AND surface=$5`,
    [sessionId, scope.ownerId, scope.botId, scope.workspaceId, scope.surface])
  if (!row.rowCount) throw new Error('notFound')
}

export const conversationAddress = (scope: EveScope) => JSON.stringify(['mikka', scope.ownerId, scope.workspaceId, scope.botId, scope.surface])
