import 'server-only'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { projectDb, projects } from '@/lib/db/projects'
import { projectTasks } from '@/lib/db/project-schema'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import { organizationWorkspaces } from '@/lib/db/governance-schema'
import type { IssueReader } from '@/lib/issue-visibility'
import { issueVisibilityPredicate } from '@/lib/issue-visibility-policy'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { actingContext } from '@/lib/activity-actor'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { lockTeamRelations } from '@/lib/team-access'
import { ProjectMapError } from './contracts'
import { MAP_NODE_LIMIT, MapReadError } from './read-contracts'

export type ProjectScope = {
  reader: IssueReader; userId: string; workspaceId: string; projectId: string;
  project: Pick<typeof projects.$inferSelect, 'id' | 'userId' | 'name' | 'revision' | 'issueIds' | 'createdAt'>; issueIds: string[];
  /** Fresh workspace classification from a map GET's membership read; rechecked after its snapshot. */
  personalWorkspace?: boolean;
  runId?: string; botId?: string | null;
}
type WorkspaceExecutor = Pick<typeof projectDb, 'select'>

export function readerId(reader: IssueReader) { return typeof reader === 'string' ? reader : reader.id }
function tokenScope(reader: IssueReader) {
  if (typeof reader !== 'string') return reader[tokenWorkspace]
  const actor = actingContext.getStore()
  return actor?.userId === reader ? actor.tokenWorkspaceId : undefined
}

const databaseUuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** Only the SQL transport is compact: preserve every raw link, including
 * duplicates and invalid team pairs, before applying the existing scope rules. */
export function decodeProjectReadLinks(workspaceId: string, rawLinks: unknown, rawIssueLinks: unknown) {
  if (!Array.isArray(rawLinks) || !Array.isArray(rawIssueLinks) || rawLinks.length > 100 || rawIssueLinks.length > 100)
    throw new ProjectMapError('PROJECT_SCOPE_CONFLICT', 409)
  // PostgreSQL returns UUID columns in lower case, including for upper-case
  // request IDs. Keep that representation rather than changing scope equality.
  const currentWorkspace = workspaceId.toLowerCase()
  const decodeWorkspace = (value: unknown) => {
    if (value === 0) return currentWorkspace
    if (typeof value === 'string' && databaseUuid.test(value)) return value
    throw new ProjectMapError('PROJECT_SCOPE_CONFLICT', 409)
  }
  return {
    links: rawLinks.map(value => ({ workspaceId: decodeWorkspace(value) })),
    issueLinks: rawIssueLinks.map((row: unknown) => {
      if (!Array.isArray(row) || row.length !== 3 || typeof row[0] !== 'string' || !databaseUuid.test(row[0]) || (row[2] !== 0 && row[2] !== 1))
        throw new ProjectMapError('PROJECT_SCOPE_CONFLICT', 409)
      const linkedWorkspace = decodeWorkspace(row[1])
      if (row[2] === 1 && linkedWorkspace !== currentWorkspace) throw new ProjectMapError('PROJECT_SCOPE_CONFLICT', 409)
      return { issueId: row[0], workspaceId: linkedWorkspace, allowed: row[2] === 1 }
    }),
  }
}

/** Stored JSON membership is deliberately absent from this projection. The
 * canonical relation is read under the same Workspace snapshot as membership.
 * Map GET retains one Workspace read and one application read. */
function projectTaskIds(bounded: boolean) {
  return sql<string[]>`ARRAY(SELECT relation."issueId" FROM ${projectTasks} relation
    WHERE relation."projectId"=${projects.id} AND relation."workspaceId"=${projects.workspaceId}
    ORDER BY relation."issueId" ${bounded ? sql`LIMIT ${MAP_NODE_LIMIT + 1}` : sql``})`
}

async function canonicalProject(reader: IssueReader, projectId: string, workspaceId: string, executor: WorkspaceExecutor, bounded: boolean) {
  if (![projectId, workspaceId].every(id => z.uuid().safeParse(id).success)) throw new ProjectMapError('INVALID_SCOPE')
  const userId = readerId(reader)
  if (tokenScope(reader) && tokenScope(reader) !== workspaceId) throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  const [row] = await executor.select({
    workspace: { kind: workspaces.kind, userId: workspaces.userId },
    organizationId: organizationWorkspaces.organizationId,
    project: { id: projects.id, userId: projects.userId, name: projects.name, revision: projects.revision,
      issueIds: projectTaskIds(bounded), createdAt: projects.createdAt },
  }).from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id),
      eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .leftJoin(organizationWorkspaces, eq(organizationWorkspaces.workspaceId, workspaces.id))
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId),
      or(eq(workspaces.kind, 'team'), and(eq(workspaces.kind, 'personal'), eq(workspaces.userId, userId)))))
    .limit(1)
  if (!row) throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  // Enterprise policy and the authenticated principal are checked on every
  // map read; a stale source row cannot bypass a detached organization.
  const { filterEnterpriseWorkspaceLinks } = await import('@/lib/enterprise/access')
  const scopedReader: IssueReader = { ...(typeof reader === 'string' ? { id: reader } : reader), [tokenWorkspace]: workspaceId,
    [enterprisePrincipal]: typeof reader === 'string' ? undefined : reader[enterprisePrincipal] }
  if (!(await filterEnterpriseWorkspaceLinks(scopedReader, [{ id: workspaceId, organizationId: row.organizationId }])).length)
    throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  if (!Array.isArray(row.project.issueIds) || row.project.issueIds.some(id => !databaseUuid.test(id)))
    throw new ProjectMapError('PROJECT_SCOPE_CONFLICT', 409)
  if (bounded && row.project.issueIds.length > MAP_NODE_LIMIT) throw new MapReadError('map_too_large', { detail: 'limit' })
  return row
}

/** Rechecked after the content snapshot; no Team grouping or creator grants access. */
export async function resolveProjectReadScope(reader: IssueReader, projectId: string, workspaceId: string): Promise<ProjectScope> {
  const userId = readerId(reader)
  const { project, workspace } = await canonicalProject(reader, projectId, workspaceId, projectDb, true)
  const { resourceActionAllowed } = await import('@/lib/resource-access/store')
  if (!await resourceActionAllowed(db, userId, { kind: 'project', id: projectId, workspaceId }, 'canReadContent'))
    throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  const scopedReader: IssueReader = { id: userId, [tokenWorkspace]: workspaceId }
  const predicate = issueVisibilityPredicate(userId, { allowedIds: [], workspaceIds: [workspaceId] })
  const visible = project.issueIds.length ? await db.select({ id: issues.id }).from(issues)
    .where(and(inArray(issues.id, project.issueIds), predicate)) : []
  return { reader: scopedReader, userId, workspaceId, projectId, project,
    issueIds: visible.map(issue => issue.id), personalWorkspace: workspace.kind === 'personal' }
}

/** No project-name matching, creator fallback, cross-request cache or cross-DB join. */
export async function resolveProjectScope(reader: IssueReader, projectId: string, workspaceId: string, executor: WorkspaceExecutor = projectDb, authorizedIssueIds?: string[]): Promise<ProjectScope> {
  const userId = readerId(reader)
  const { project, workspace } = await canonicalProject(reader, projectId, workspaceId, executor, false)
  const { activeTaskWorkspaces } = await import('@/lib/task-workspace')
  const { resourceActionAllowed } = await import('@/lib/resource-access/store')
  const scopedReader: IssueReader = { id: userId, [tokenWorkspace]: workspaceId }
  if (!(await activeTaskWorkspaces(scopedReader, workspaceId)).length
    || !await resourceActionAllowed(db, userId, { kind: 'project', id: projectId, workspaceId }, 'canReadContent'))
    throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  if (authorizedIssueIds) return { reader: scopedReader, userId, workspaceId, projectId, project,
    issueIds: project.issueIds.filter(id => authorizedIssueIds.includes(id)), personalWorkspace: workspace.kind === 'personal' }
  const predicate = issueVisibilityPredicate(userId, { allowedIds: [], workspaceIds: [workspaceId] })
  const visible = project.issueIds.length ? await db.select({ id: issues.id }).from(issues)
    .where(and(inArray(issues.id, project.issueIds), predicate)) : []
  return { reader: scopedReader, userId, workspaceId, projectId, project,
    issueIds: visible.map(issue => issue.id), personalWorkspace: workspace.kind === 'personal' }
}

/** A task's one structural relation resolves its Project, never a display name. */
export async function projectForIssue(reader: IssueReader, issueId: string, workspaceId: string) {
  if (![issueId, workspaceId].every(id => z.uuid().safeParse(id).success)) throw new ProjectMapError('INVALID_SCOPE')
  const [relation] = await projectDb.select({ projectId: projectTasks.projectId }).from(projectTasks)
    .where(and(eq(projectTasks.issueId, issueId), eq(projectTasks.workspaceId, workspaceId))).limit(1)
  if (!relation) throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  const scope = await resolveProjectScope(reader, relation.projectId, workspaceId)
  if (!scope.issueIds.includes(issueId)) throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
  return scope
}

/** Match task admission's lock order: Workspace, member, relations, Project.
 * A completed membership revocation cannot be bypassed by an old map snapshot. */
export async function withProjectWriteScope<T>(reader: IssueReader, projectId: string, workspaceId: string, operation: (scope: ProjectScope) => Promise<T>): Promise<T> {
  const observed = await resolveProjectScope(reader, projectId, workspaceId)
  const { withTaskWorkspace } = await import('@/lib/task-workspace')
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    await lockTeamRelations(tx)
    const [current] = await tx.select({ id: projects.id, archivedAt: projects.archivedAt }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId))).for('share')
    if (!current) throw new ProjectMapError('PROJECT_NOT_FOUND', 404)
    if (current.archivedAt) throw new ProjectMapError('PROJECT_ARCHIVED', 409)
    const scope = await resolveProjectScope(reader, projectId, workspaceId, tx, observed.issueIds)
    const { withResourceAccess } = await import('@/lib/resource-access/store')
    return withResourceAccess(reader, { kind: 'project', id: projectId, workspaceId }, 'canSteer', () => operation(scope))
  })
}
