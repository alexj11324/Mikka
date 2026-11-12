import 'server-only'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { workspaceListChanged } from '@/lib/live/lists'
import type { EnterpriseReader } from '@/lib/enterprise/principal'
import type { ResourceAction } from '@/lib/resource-access/contract'
import { lockResourcesAccess } from '@/lib/resource-access/store'
import { GovernanceError } from './errors'
import { withServiceIdentityAdmin } from './service-identities'

const ids = z.array(z.uuid().transform(value => value.toLowerCase())).max(200)
  .refine(values => new Set(values).size === values.length)
const replace = z.object({ expectedProjectIds: ids, projectIds: ids, confirmExpansion: z.boolean().default(false) }).strict()
type AppTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function assignedProjects(tx: AppTransaction, workspaceId: string, identityId: string) {
  const { rows } = await tx.execute<{ id: string }>(sql`SELECT p.id FROM resource_access_grants g
    JOIN resource_access_policies p ON p.kind=g."resourceKind" AND p.id=g."resourceId"
    WHERE p."workspaceId"=${workspaceId}::uuid AND g."resourceKind"='project'
      AND g."subjectKind"='service' AND g."subjectId"=${identityId} ORDER BY p.id`)
  return rows.map(row => row.id)
}

async function lockManageableProjects(tx: AppTransaction, workspaceId: string, actorId: string, projectIds: string[], write: boolean, actions: readonly ResourceAction[] = ['canManageAccess']) {
  try {
    await lockResourcesAccess(tx, actorId, projectIds.flatMap(id => actions.map(action => ({
      reference: { kind: 'project' as const, id, workspaceId }, action,
    }))), write, false)
  } catch (cause) {
    if (cause instanceof ActionFailureError && cause.code === 'issueNotFound') throw new GovernanceError('not_found', cause)
    throw cause
  }
}

/** Keep the real Workspace lease through the sole writing transaction in APP.
 * Management of an identity never gives its admin control of another owner's Project. */
export function serviceProjectAccess(workspaceId: string, actor: EnterpriseReader, rawId: string, input?: unknown) {
  const identityId = z.uuid().parse(rawId).toLowerCase()
  const change = input === undefined ? undefined : replace.parse(input)
  return withServiceIdentityAdmin(workspaceId, actor, async workspace => {
    const { rows: [identity] } = await workspace.execute<{ enabled: boolean }>(sql`SELECT enabled FROM mikka_workspace_service_identities
      WHERE "workspaceId"=${workspaceId}::uuid AND id=${identityId}::uuid FOR SHARE`)
    if (!identity) throw new GovernanceError('not_found')
    return db.transaction(async tx => {
      const previous = await assignedProjects(tx, workspaceId, identityId)
      const target = change ? [...change.projectIds].sort() : previous
      const all = [...new Set([...previous, ...target])]
      // Verify all rows before returning even their IDs, or changing any grants.
      await lockManageableProjects(tx, workspaceId, actor.id, all, Boolean(change))
      const locked = await assignedProjects(tx, workspaceId, identityId)
      if (JSON.stringify(previous) !== JSON.stringify(locked)) throw new GovernanceError('service_projects_changed')
      if (!change) return { projectIds: previous }
      if (JSON.stringify(previous) !== JSON.stringify([...change.expectedProjectIds].sort())) throw new GovernanceError('service_projects_changed')
      const added = target.filter(id => !previous.includes(id))
      const removed = previous.filter(id => !target.includes(id))
      if (added.length && !identity.enabled) throw new GovernanceError('service_identity_disabled')
      if (added.length && !change.confirmExpansion) throw new GovernanceError('service_projects_confirmation')
      if (added.length || removed.length) {
        await tx.execute(sql`SELECT set_config('mikka.acl_actor',${actor.id},true),set_config('mikka.acl_source','service_project_assignment',true)`)
        if (removed.length) await tx.execute(sql`DELETE FROM resource_access_grants WHERE "resourceKind"='project'
          AND "subjectKind"='service' AND "subjectId"=${identityId} AND "resourceId"=ANY(${sql.param(removed)}::uuid[])`)
        if (added.length) await tx.execute(sql`INSERT INTO resource_access_grants ("resourceKind","resourceId","subjectKind","subjectId",capabilities)
          SELECT 'project',id,'service',${identityId},ARRAY['canReadContent'] FROM unnest(${sql.param(added)}::uuid[]) AS project(id)`)
        await workspaceListChanged(tx, workspaceId, ['workspace_settings'])
      }
      return { projectIds: target }
    })
  })
}

/** List Projects the signed-in administrator can actually share, using the same
 * APP ACL used by a replacement. Read names only in the selected Workspace. */
export function serviceProjectChoices(workspaceId: string, actor: EnterpriseReader, rawId: string, after: string | null) {
  const identityId = z.uuid().parse(rawId)
  const cursor = z.uuid().nullable().parse(after)
  return withServiceIdentityAdmin(workspaceId, actor, async workspace => {
    const { rows: identities } = await workspace.execute(sql`SELECT id FROM mikka_workspace_service_identities
      WHERE "workspaceId"=${workspaceId}::uuid AND id=${identityId}::uuid FOR SHARE`)
    if (!identities.length) throw new GovernanceError('not_found')
    return db.transaction(async app => {
      const { rows } = await app.execute<{ id: string }>(sql`SELECT id FROM resource_access_policies
        WHERE kind='project' AND "workspaceId"=${workspaceId}::uuid AND (${cursor}::uuid IS NULL OR id>${cursor}::uuid)
          AND mikka_resource_acl_allowed('account',${actor.id},"workspaceId",kind,id,'canReadContent')
          AND mikka_resource_acl_allowed('account',${actor.id},"workspaceId",kind,id,'canManageAccess')
        ORDER BY id LIMIT 101`)
      const page = rows.slice(0, 100)
      await lockManageableProjects(app, workspaceId, actor.id, page.map(row => row.id), false, ['canManageAccess', 'canReadContent'])
      const { rows: projects } = await workspace.execute<{ id: string; name: string }>(sql`SELECT id,name FROM workspace_projects
        WHERE "workspaceId"=${workspaceId}::uuid AND id=ANY(${sql.param(page.map(row => row.id))}::uuid[])
          AND "archivedAt" IS NULL ORDER BY id`)
      return { projects, nextCursor: rows.length > 100 ? page[99].id : null }
    })
  })
}
