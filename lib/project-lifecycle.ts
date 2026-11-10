import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { projects, projectEvents } from '@/lib/db/projects'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { accessibleProjects, requireProjectWrite, type ProjectReader, type ProjectTransaction } from '@/lib/project-access'
import { lockTeamRelations } from '@/lib/team-access'
import { withResourceAccess } from '@/lib/resource-access/store'
import { taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import { workspaceListChanged } from '@/lib/live/lists'
import { projectMapChanged } from '@/lib/live/project-map'

type Project = typeof projects.$inferSelect
type WorkspaceCounts = { issueIds: string[]; teams: number; members: number; repositories: number; environments: number; events: number; resourceEvents: number; incomingDependencies: number }
type HistoryCounts = { runs: number; activeRuns: number; factoryTasks: number; decisions: number }
export type ProjectLifecycleImpact = {
  projectId: string; workspaceId: string; name: string; revision: number; archivedAt: string | null;
  counts: Omit<WorkspaceCounts, 'issueIds'> & HistoryCounts & { tasks: number; dependencies: number; milestones: number; legacyTaskReferences: number };
  canDelete: boolean; recovery: 'restore_archive';
}

/** Called while the Workspace membership, relation and Project locks are held.
 * The application query counts frozen provenance too, so moving a task cannot
 * turn a Project with execution history into an apparently empty Project. */
async function contents(tx: ProjectTransaction, project: Project, workspaceId: string): Promise<ProjectLifecycleImpact> {
  const linked = await tx.execute<WorkspaceCounts>(sql`select
    ARRAY(select "issueId" from workspace_project_tasks where "projectId"=${project.id} and "workspaceId"=${workspaceId} order by "issueId") as "issueIds",
    (select count(*)::int from mikka_team_projects where "projectId"=${project.id}) as teams,
    (select count(*)::int from workspace_project_members where "projectId"=${project.id}) as members,
    (select count(*)::int from workspace_project_repositories where "projectId"=${project.id}) as repositories,
    (select count(*)::int from workspace_project_environments where "projectId"=${project.id}) as environments,
    (select count(*)::int from workspace_project_events where "projectId"=${project.id}) as events,
    (select count(*)::int from workspace_resource_events where "workspaceId"=${workspaceId} and "resourceId"=${project.id}) as "resourceEvents",
    (select count(*)::int from workspace_projects where "workspaceId"=${workspaceId} and id<>${project.id} and properties->'dependencyIds' @> ${JSON.stringify([project.id])}::jsonb) as "incomingDependencies"`)
  const { issueIds, ...workspaceCounts } = linked.rows[0]
  const history = await db.execute<HistoryCounts>(sql`with scoped_tasks as (
      select id from issues where id=any(${sql.param(issueIds)}::uuid[]) and "workspaceId"=${workspaceId} and "ownershipState"='bound'
    ), historical_runs as (
      select id,status from agent_runs where
        ("workspaceId"=${workspaceId} and "agentDefinition"->'projectExecution'->>'projectId'=${project.id})
        or (("workspaceId"=${workspaceId} or "workspaceId" is null) and "issueId" in (select id from scoped_tasks))
    ) select
      (select count(*)::int from historical_runs) as runs,
      (select count(*)::int from historical_runs where status not in ('succeeded','stopped','failed','cancelled')) as "activeRuns",
      (select count(*)::int from factory_tasks f where (f."workspaceId"=${workspaceId} or f."workspaceId" is null)
        and (f."issueId" in (select id from scoped_tasks) or exists (
          select 1 from factory_attempts a where a."taskId"=f.id and a."runId" in (select id from historical_runs)))) as "factoryTasks",
      (select count(*)::int from project_decisions where "workspaceId"=${workspaceId} and "projectId"=${project.id}) as decisions`)
  const counts = { ...workspaceCounts, ...history.rows[0], tasks: issueIds.length,
    dependencies: project.properties.dependencyIds?.length ?? 0, milestones: project.properties.milestones?.length ?? 0,
    legacyTaskReferences: project.issueIds?.length ?? 0 }
  return { projectId: project.id, workspaceId, name: project.name, revision: project.revision,
    archivedAt: project.archivedAt?.toISOString() ?? null, counts,
    canDelete: Object.values(counts).every(count => count === 0), recovery: 'restore_archive' }
}

async function lockedProject<T>(reader: ProjectReader, workspaceId: string, id: string,
  action: 'canReadContent' | 'canSteer', operation: (tx: ProjectTransaction, project: Project) => Promise<T>) {
  // Keep the established Workspace -> relations -> APP ACL lock order shared
  // with Project mutations; taking the ACL first can deadlock a concurrent
  // relation edit that is waiting on the same Project policy.
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    await lockTeamRelations(tx)
    return withResourceAccess(reader, { kind: 'project', id, workspaceId }, action,
      async () => operation(tx, await requireProjectWrite(tx, reader, id, workspaceId, { allowArchived: true })))
  })
}

async function journal(tx: ProjectTransaction, project: Project, reader: ProjectReader, workspaceId: string, kind: string, detail: object) {
  const id = crypto.randomUUID()
  await tx.execute(sql`insert into workspace_resource_events(id,"workspaceId","actorId",kind,"resourceId",detail)
    values(${id},${workspaceId},${taskReaderScope(reader).userId},${kind},${project.id},${JSON.stringify({ name: project.name, status: project.status, revision: project.revision, ...detail })}::jsonb)`)
  return id
}

export async function projectLifecycleImpact(reader: ProjectReader, workspaceId: string, id: string) {
  return lockedProject(reader, workspaceId, id, 'canReadContent', (tx, project) => contents(tx, project, workspaceId))
}

/** Archive is independent of delivery status. Existing tasks, Runs, decisions
 * and bindings remain addressable; new admission fails until an explicit restore. */
export async function setProjectArchive(reader: ProjectReader, workspaceId: string, input: { id: string; revision?: number; archived: boolean; message: string }) {
  return lockedProject(reader, workspaceId, input.id, 'canSteer', async (tx, project) => {
    if (input.revision !== undefined && input.revision !== project.revision) throw new ActionFailureError('projectSaveConflict')
    if (Boolean(project.archivedAt) !== input.archived) {
      const actorId = taskReaderScope(reader).userId, updatedAt = new Date()
      await journal(tx, project, reader, workspaceId, input.archived ? 'project.archived' : 'project.restored', { archived: input.archived })
      await tx.update(projects).set({ archivedAt: input.archived ? updatedAt : null, archivedBy: input.archived ? actorId : null,
        revision: project.revision + 1, updatedAt }).where(eq(projects.id, project.id))
      await tx.insert(projectEvents).values({ id: crypto.randomUUID(), projectId: project.id, userId: actorId, message: input.message })
      await projectMapChanged(tx, project.id)
      await workspaceListChanged(tx, workspaceId, ['workspace_settings', 'issue_list'])
    }
    const [saved] = await accessibleProjects(reader, tx, workspaceId, project.id)
    return saved
  })
}

/** A hard delete never becomes an implicit archive. History is not recoverable
 * by this API, so only a confirmed, truly unused Project may be removed. */
export async function deleteProjectData(reader: ProjectReader, workspaceId: string, input: { id: string; revision: number; confirmation: string }) {
  return lockedProject(reader, workspaceId, input.id, 'canSteer', async (tx, project) => {
    const [member] = await tx.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, taskReaderScope(reader).userId)))
    if (member?.role !== 'admin') throw new ActionFailureError('workspaceAccessDenied')
    if (input.revision !== project.revision) throw new ActionFailureError('projectSaveConflict')
    if (input.confirmation.trim() !== project.name) throw new ActionFailureError('projectCheckFields')
    const impact = await contents(tx, project, workspaceId)
    if (!impact.canDelete) throw new ActionFailureError('projectDeleteNotEmpty')
    const auditId = await journal(tx, project, reader, workspaceId, 'project.deleted', { counts: impact.counts })
    await tx.delete(projects).where(and(eq(projects.id, project.id), eq(projects.workspaceId, workspaceId)))
    // The Project ACL lives in the APP database and has no source-delete
    // trigger. Remove it inside the same authorization lease so a deleted ID
    // cannot later be reused as an accessible Project.
    await db.execute(sql`delete from resource_access_policies where kind='project' and id=${project.id} and "workspaceId"=${workspaceId}`)
    await workspaceListChanged(tx, workspaceId, ['workspace_settings'])
    return { deleted: true as const, projectId: project.id, auditId }
  })
}
