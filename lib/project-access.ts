import 'server-only'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { projectDb, projects, projectTasks, projectMembers } from '@/lib/db/projects'
import { workspaces, workspaceMembers } from '@/lib/db/workspace-schema'
import { taskReaderScope } from '@/lib/task-workspace'

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

/** Caller holds withTaskWorkspace and lockTeamRelations before taking this row lock.
 * It intentionally uses only the Workspace DB, including the fresh ACL check. */
export async function requireProjectWrite(tx: ProjectTransaction, reader: ProjectReader, projectId: string, workspaceId: string, options: { allowArchived?: boolean } = {}) {
  const [row] = await tx.select({ project: projects }).from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, projects.workspaceId))
    .where(and(eq(projects.id, projectId), projectMembership(reader, workspaceId)))
    .for('update', { of: projects })
  if (!row) throw new ActionFailureError('projectNotFound')
  if (row.project.archivedAt && !options.allowArchived) throw new ActionFailureError('projectArchived')
  return row.project
}

/** Explicit active tenant only. No creator, Team, name or legacy JSONB fallback. */
export async function accessibleProjects(reader: ProjectReader, tx: ProjectTransaction | typeof projectDb = projectDb, workspaceId?: string, projectId?: string) {
  if (!workspaceId) return []
  const rows = await tx.select({
    project: projects,
    issueIds: sql<string[]>`coalesce((select jsonb_agg(pt."issueId" order by pt."issueId") from ${projectTasks} pt where pt."projectId" = ${projects.id} and pt."workspaceId" = ${projects.workspaceId}), '[]'::jsonb)`,
    memberIds: sql<string[]>`coalesce((select jsonb_agg(pm."userId" order by pm."userId") from ${projectMembers} pm where pm."projectId" = ${projects.id} and pm."workspaceId" = ${projects.workspaceId}), '[]'::jsonb)`,
  }).from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, projects.workspaceId))
    .where(and(projectMembership(reader, workspaceId), projectId ? eq(projects.id, projectId) : undefined))
  return rows.map(({ project, issueIds, memberIds }) => ({
    ...project, createdBy: project.userId, issueIds, memberIds,
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
