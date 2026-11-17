import 'server-only'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { projectDb, projects, projectTasks, projectMembers } from '@/lib/db/projects'
import { workspaces, workspaceMembers } from '@/lib/db/workspace-schema'
import { activeTaskWorkspaces, taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import type { ResourceReference } from '@/lib/resource-access/contract'

export type ProjectTransaction = Parameters<Parameters<typeof projectDb.transaction>[0]>[0]
export type ProjectReader = Parameters<typeof taskReaderScope>[0]

function projectMembership(reader: ProjectReader, workspaceId: string) {
  const scope = taskReaderScope(reader)
  if (scope.workspaceId && scope.workspaceId !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return and(
    eq(projects.workspaceId, workspaceId),
    eq(workspaceMembers.userId, scope.userId), eq(workspaceMembers.status, 'active'),
    or(eq(workspaces.kind, 'team'), and(eq(workspaces.kind, 'personal'), eq(workspaces.userId, scope.userId))),
  )
}

/** Tenant and Enterprise admission precede APP content ACLs. Source Project
 * rows are read only after their stable IDs pass the authoritative ACL; no
 * request cache can preserve access after a grant or membership revocation.
 * A selected Workspace is required: omitting it must never enumerate every
 * tenant of a human who belongs to more than one. */
async function readProjectAccess(reader: ProjectReader, workspaceId: string) {
  if (!z.uuid().safeParse(workspaceId).success) return []
  // A pinned token Workspace that disagrees with the caller's selected tenant
  // is an explicit denial, never an empty listing that hides the mismatch.
  const scope = taskReaderScope(reader)
  if (scope.workspaceId && scope.workspaceId !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  const tenants = await activeTaskWorkspaces(reader, workspaceId)
  if (!tenants.length) return []
  const { rows } = await db.execute<{ id: string; workspaceId: string; canEditProperties: boolean }>(sql`select id,"workspaceId",
    mikka_resource_acl_allowed('account',${scope.userId},"workspaceId",kind,id,'canSteer') as "canEditProperties"
    from resource_access_policies
    where kind='project' and "workspaceId"=any(${sql.param(tenants.map(tenant => tenant.id))}::uuid[])
      and mikka_resource_acl_allowed('account',${scope.userId},"workspaceId",kind,id,'canReadContent')`)
  return rows
}

export async function accessibleProjectReferences(reader: ProjectReader, workspaceId: string): Promise<ResourceReference[]> {
  return (await readProjectAccess(reader, workspaceId)).map(({ id, workspaceId }) => ({ kind: 'project', id, workspaceId }))
}

/** Only the names needed by a selected-workspace picker. Load from the
 * canonical Project table after the current content ACL has selected the IDs. */
export async function accessibleProjectNames(reader: ProjectReader, workspaceId: string, tx: ProjectTransaction, fileLinkProjectIds?: ReadonlySet<string>) {
  const references = await accessibleProjectReferences(reader, workspaceId)
  const ids = references.map(reference => reference.id).filter(id => !fileLinkProjectIds || fileLinkProjectIds.has(id))
  if (!ids.length) return []
  const query = tx.select({ id: projects.id, name: projects.name }).from(projects)
    .where(and(
      eq(projects.workspaceId, workspaceId),
      isNull(projects.archivedAt),
      sql`${projects.id} = any(${sql.param(ids)}::uuid[])`,
    ))
    .orderBy(projects.name, projects.id)
  // File metadata resides in the installation database. Keep these canonical
  // rows active until the subsequent content query finishes.
  return fileLinkProjectIds ? query.for('share', { of: projects }) : query
}

/** Workspace membership is already held. Readers then pin just this Project
 * and its ACL. Lifecycle writers keep their established relation lock order. */
async function lockProjectRow(tx: ProjectTransaction, reader: ProjectReader, projectId: string, workspaceId: string, strength: 'share' | 'update') {
  const [row] = await tx.select({ project: projects }).from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, projects.workspaceId))
    .where(and(eq(projects.id, projectId), projectMembership(reader, workspaceId)))
    .for(strength, { of: projects })
  if (!row) throw new ActionFailureError('projectNotFound')
  return row.project
}

/** Caller holds withTaskWorkspace and lockTeamRelations before taking this row lock.
 * It intentionally uses only the Workspace DB; the content ACL lock belongs to
 * the caller's withResourceAccess lease. */
export async function requireProjectWrite(tx: ProjectTransaction, reader: ProjectReader, projectId: string, workspaceId: string, options: { allowArchived?: boolean } = {}) {
  const project = await lockProjectRow(tx, reader, projectId, workspaceId, 'update')
  if (project.archivedAt && !options.allowArchived) throw new ActionFailureError('projectArchived')
  return project
}

/** Hold the canonical source row and content authorization while serving private
 * files. A shared source-row lock orders archive/deletion with this operation
 * without serializing unrelated Projects, teams or other readers. */
export async function withReadableProject<T>(reader: ProjectReader, workspaceId: string, projectId: string, read: (app: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>, permission: 'canReadContent' | 'canSteer' = 'canReadContent') {
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    const project = await lockProjectRow(tx, reader, projectId, workspaceId, 'share')
    if (project.archivedAt) throw new ActionFailureError('projectNotFound')
    const { withResourceAccess } = await import('@/lib/resource-access/store')
    return withResourceAccess(reader, { kind: 'project', id: projectId, workspaceId }, permission, (_policy, app) => read(app))
  })
}

/** Explicit active tenant only. No creator, Team, name or legacy JSONB fallback.
 * The authoritative ACL selects stable Project IDs first; canonical relations
 * hydrate `issueIds`/`memberIds` so stored JSONB never becomes a second
 * relationship source. */
export async function accessibleProjects(reader: ProjectReader, tx: ProjectTransaction | typeof projectDb = projectDb, workspaceId?: string, projectId?: string) {
  if (!workspaceId) return []
  const references = await readProjectAccess(reader, workspaceId)
  const permissions = new Map(references.filter(reference => !projectId || reference.id === projectId).map(reference => [reference.id, reference.canEditProperties]))
  const ids = [...permissions.keys()]
  if (!ids.length) return []
  const rows = await tx.select({
    project: projects,
    issueIds: sql<string[]>`coalesce((select jsonb_agg(pt."issueId" order by pt."issueId") from ${projectTasks} pt where pt."projectId" = ${projects.id} and pt."workspaceId" = ${projects.workspaceId}), '[]'::jsonb)`,
    memberIds: sql<string[]>`coalesce((select jsonb_agg(pm."userId" order by pm."userId") from ${projectMembers} pm where pm."projectId" = ${projects.id} and pm."workspaceId" = ${projects.workspaceId}), '[]'::jsonb)`,
  }).from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, projects.workspaceId))
    .where(and(projectMembership(reader, workspaceId), inArray(projects.id, ids)))
  return rows.map(({ project, issueIds, memberIds }) => ({
    ...project, workspaceId, createdBy: project.userId, issueIds, memberIds, canEditProperties: permissions.get(project.id) === true,
    lead: project.leadUserId ?? '',
    properties: { ...project.properties, members: memberIds },
  }))
}

/** Display projection for tasks already authorized by their caller. Exact tenant
 * pairing protects split databases against malformed cross-tenant link rows. */
export async function projectViewsForTasks(tasks: readonly { id: string; workspaceId: string | null }[]) {
  const tenants = new Map(tasks.filter(task => task.workspaceId).map(task => [task.id, task.workspaceId]))
  const result = new Map<string, { projectId: string; project: string }>()
  const ids = [...tenants.keys()]
  for (let offset = 0; offset < ids.length; offset += 200) {
    const rows = await projectDb.select({ issueId: projectTasks.issueId, projectId: projects.id, project: projects.name, workspaceId: projectTasks.workspaceId })
      .from(projectTasks).innerJoin(projects, and(eq(projects.id, projectTasks.projectId), eq(projects.workspaceId, projectTasks.workspaceId)))
      .where(inArray(projectTasks.issueId, ids.slice(offset, offset + 200)))
    for (const row of rows) if (tenants.get(row.issueId) === row.workspaceId) result.set(row.issueId, { projectId: row.projectId, project: row.project })
  }
  return result
}
