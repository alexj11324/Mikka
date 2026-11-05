import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { projectDb, projects } from '@/lib/db/projects'
import { teamProjects } from '@/lib/db/team-schema'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import { issueVisibility, type IssueReader } from '@/lib/issue-visibility'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { actingContext } from '@/lib/activity-actor'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { lockTeamRelations } from '@/lib/team-access'
import { ProjectMapError } from './contracts'

export type ProjectScope = {
  reader: IssueReader; userId: string; workspaceId: string; projectId: string;
  project: Pick<typeof projects.$inferSelect, 'id' | 'userId' | 'name' | 'revision' | 'issueIds' | 'createdAt'>; issueIds: string[];
  runId?: string; botId?: string | null;
}
type WorkspaceExecutor = Pick<typeof projectDb, 'select'>

export function readerId(reader: IssueReader) { return typeof reader === 'string' ? reader : reader.id }
function tokenScope(reader: IssueReader) {
  if (typeof reader !== 'string') return reader[tokenWorkspace]
  const actor = actingContext.getStore()
  return actor?.userId === reader ? actor.tokenWorkspaceId : undefined
}

/** No name matching, current-workspace cookie, cross-request cache, or cross-database join. */
export async function resolveProjectScope(reader: IssueReader, projectId: string, workspaceId: string, executor: WorkspaceExecutor = projectDb, authorizedIssueIds?: string[]): Promise<ProjectScope> {
  if (![projectId, workspaceId].every(id => z.uuid().safeParse(id).success)) throw new ProjectMapError('INVALID_SCOPE')
  const userId = readerId(reader)
  if (tokenScope(reader) && tokenScope(reader) !== workspaceId) throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  const scopedReader: IssueReader = { id: userId, [tokenWorkspace]: workspaceId }
  const [membership] = await executor.select({ workspace: { kind: workspaces.kind, userId: workspaces.userId } }).from(workspaces)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .where(eq(workspaces.id, workspaceId)).limit(1)
  if (!membership) throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  const [project] = await executor.select({ id: projects.id, userId: projects.userId, name: projects.name, revision: projects.revision, issueIds: sql<string[] | null>`CASE WHEN jsonb_typeof(${projects.issueIds})='array' AND octet_length(${projects.issueIds}::text)<=4096 THEN CASE WHEN jsonb_array_length(${projects.issueIds})<=100 THEN ${projects.issueIds} ELSE NULL END ELSE NULL END`, createdAt: projects.createdAt }).from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  const links = await executor.select({ workspaceId: teamProjects.workspaceId }).from(teamProjects).where(eq(teamProjects.projectId, projectId)).limit(101)
  if (links.length > 100) throw new ProjectMapError('PROJECT_SCOPE_CONFLICT', 409)
  const workspacesForProject = new Set(links.map(link => link.workspaceId))
  // Report malformed ownership only to a member of one of the project's workspaces.
  if (links.length && !workspacesForProject.has(workspaceId)) throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  if (workspacesForProject.size > 1) throw new ProjectMapError('PROJECT_SCOPE_CONFLICT', 409)
  if (!links.length && (project.userId !== userId || membership.workspace.kind !== 'personal' || membership.workspace.userId !== userId))
    throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  if (!Array.isArray(project.issueIds)) throw new ProjectMapError('PROJECT_SCOPE_CONFLICT', 409)
  const checkedProject = { ...project, issueIds: project.issueIds }
  const candidateIds = [...new Set(project.issueIds)].filter(id => z.uuid().safeParse(id).success)
  if (candidateIds.length > 100) throw new ProjectMapError('PROJECT_SCOPE_CONFLICT', 409)
  if (authorizedIssueIds) return { reader: scopedReader, userId, workspaceId, projectId, project: checkedProject, issueIds: candidateIds.filter(id => authorizedIssueIds.includes(id)) }
  const visibility = await issueVisibility(scopedReader, false, workspaceId, db, { onlyIssueIds: candidateIds })
  const visible = candidateIds.length ? await db.select({ id: issues.id, deleted: sql<boolean>`(COALESCE(${issues.content}->'attrs'->'mikka',${issues.content}->'attrs'->'orvilo')->>'deletedAt') IS NOT NULL` }).from(issues)
    .where(and(inArray(issues.id, candidateIds), visibility.predicate)) : []
  const issueIds = visible.filter(row => !row.deleted).map(row => row.id)
  return { reader: scopedReader, userId, workspaceId, projectId, project: checkedProject, issueIds }
}

/** A run without an explicit project may resolve only one structural project association. */
export async function projectForIssue(reader: IssueReader, issueId: string, workspaceId: string) {
  const candidates = await projectDb.select({ id: projects.id }).from(projects).where(sql`${projects.issueIds} @> ${JSON.stringify([issueId])}::jsonb`).limit(100)
  const matches: ProjectScope[] = []
  for (const project of candidates) {
    try {
      const scope = await resolveProjectScope(reader, project.id, workspaceId)
      if (scope.issueIds.includes(issueId)) matches.push(scope)
    } catch (error) {
      if (!(error instanceof ProjectMapError && error.status === 404)) throw error
    }
  }
  if (matches.length !== 1) throw new ProjectMapError(matches.length ? 'PROJECT_REQUIRED' : 'PROJECT_NOT_FOUND', matches.length ? 400 : 404)
  return matches[0]
}

/** Keep project and membership changes from racing a decision commit. */
export async function withProjectWriteScope<T>(reader: IssueReader, projectId: string, workspaceId: string, operation: (scope: ProjectScope) => Promise<T>): Promise<T> {
  const observed = await resolveProjectScope(reader, projectId, workspaceId)
  return projectDb.transaction(async tx => {
    await lockTeamRelations(tx)
    const userId = readerId(reader)
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for('share')
    await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).for('share')
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('share')
    await tx.select({ projectId: teamProjects.projectId }).from(teamProjects).where(eq(teamProjects.projectId, projectId)).for('share')
    const scope = await resolveProjectScope(reader, projectId, workspaceId, tx, observed.issueIds)
    return operation(scope)
  })
}
