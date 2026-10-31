import 'server-only'
import { db, pool } from '@/lib/db'
import { recordAudit } from '@/lib/audit/record'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { sql } from 'drizzle-orm'
import { personalPolicyInput, readPersonalPolicy, type PersonalPolicy } from '@/lib/personal-policy'

export interface PersonalPolicyView extends PersonalPolicy { canEdit: boolean }

/** Any member reads; `canEdit` for admins of a team workspace (a personal workspace has no switches). */
export async function getPersonalPolicy(actorId: string, workspaceId: string): Promise<PersonalPolicyView> {
  const { workspace, membership } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId))
  return { ...await readPersonalPolicy(pool, workspaceId), canEdit: membership.role === 'admin' && workspace.kind === 'team' }
}

/** Admins of a team workspace only. The change and its audit row commit together. */
export async function setPersonalPolicy(actor: { id: string; name: string }, workspaceId: string, input: unknown, request: { ip?: string | null; geoCity?: string | null; geoCountry?: string | null; geoRegion?: string | null } = {}): Promise<PersonalPolicyView> {
  const { resource, allowed } = personalPolicyInput.parse(input)
  const { workspace } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actor.id, true))
  if (workspace.kind !== 'team') throw new WorkspaceError('validationGeneric')
  await db.transaction(async tx => {
    const column = sql.identifier(resource)
    const { rows: [current] } = await tx.execute<{ allowed: boolean }>(sql`SELECT ${column} AS allowed FROM workspace_personal_policies WHERE "workspaceId"=${workspaceId} FOR UPDATE`)
    const previous = current?.allowed ?? true
    if (previous === allowed) return
    await tx.execute(sql`INSERT INTO workspace_personal_policies ("workspaceId",${column},"updatedBy","updatedAt") VALUES (${workspaceId},${allowed},${actor.id},now())
      ON CONFLICT ("workspaceId") DO UPDATE SET ${column}=EXCLUDED.${column},"updatedBy"=EXCLUDED."updatedBy","updatedAt"=now()`)
    await recordAudit(tx, { workspaceId, actor: { type: 'user', id: actor.id, name: actor.name }, action: 'integration.permission_changed', target: { type: 'personal', id: resource, label: resource }, metadata: { integration: `personal_${resource}`, capability: 'use', from: previous ? 'allow' : 'deny', to: allowed ? 'allow' : 'deny' }, ...request })
  })
  return getPersonalPolicy(actor.id, workspaceId)
}
