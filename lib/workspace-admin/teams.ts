import 'server-only'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { markReviewSessionsRevoked, drainRevokedReviewSessions } from '../coding-workspace/review-sessions'
import { issues } from '@/lib/db/schema'
import { projects } from '@/lib/db/project-schema'
import { teamIssueCreateReceipts, teamIssuePromotionReceipts, teamIssues, teamLifecycleEvents, teamMembers, teamProjects, teams } from '@/lib/db/team-schema'
import { requireWorkspace, WorkspaceError, type WorkspaceTransaction } from '@/lib/workspace-access'
import { lockTeamRelations } from '@/lib/team-access'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceListChanged } from '../live/lists'

export interface TeamDeletionImpact {
  teamId: string; name: string; tasks: number; projects: number; runs: number; pullRequests: number
  archivedAt: string | null; canDelete: boolean; recovery: 'restore_archive'
}
export type TeamLifecycleImpact = TeamDeletionImpact
export interface TeamLifecycleChange { teamId: string; archivedAt: string | null; auditId: string | null }
export interface TeamGroupingRemoval { removed: { teamId: string; tasks: number; projects: number }; auditId: string }
export interface TeamDeletion { deleted: { tasks: number; projects: number }; auditId: string }

/** Workspace/member, relation lock, Team: the canonical task/project lock order. */
async function lockTeam(tx: WorkspaceTransaction, actorId: string, teamId: string) {
  z.uuid().parse(teamId)
  const [scope] = await tx.select({ workspaceId: teams.workspaceId }).from(teams).where(eq(teams.id, teamId)).limit(1)
  if (!scope) throw new WorkspaceError('teamNotFound')
  await requireWorkspace(tx, scope.workspaceId, actorId, true)
  await lockTeamRelations(tx)
  const [team] = await tx.select().from(teams).where(and(eq(teams.id, teamId), eq(teams.workspaceId, scope.workspaceId))).for('update').limit(1)
  if (!team) throw new WorkspaceError('teamNotFound')
  return team
}

async function teamContents(tx: WorkspaceTransaction, team: typeof teams.$inferSelect) {
  const issueLinks = await tx.select().from(teamIssues).where(eq(teamIssues.teamId, team.id))
  const projectLinks = await tx.select().from(teamProjects).where(eq(teamProjects.teamId, team.id))
  const members = await tx.select({ userId: teamMembers.userId, role: teamMembers.role }).from(teamMembers).where(eq(teamMembers.teamId, team.id))
  const issueIds = issueLinks.map(link => link.issueId)
  const taskRows = issueIds.length ? await db.select({ id: issues.id, workspaceId: issues.workspaceId, ownershipState: issues.ownershipState }).from(issues).where(inArray(issues.id, issueIds)) : []
  const scopedTaskIds = taskRows.filter(task => task.ownershipState === 'bound' && task.workspaceId === team.workspaceId).map(task => task.id)
  const projectIds = projectLinks.map(link => link.projectId)
  const projectRows = projectIds.length ? await tx.select({ id: projects.id, workspaceId: projects.workspaceId }).from(projects).where(inArray(projects.id, projectIds)) : []
  // Count frozen team provenance too: moving a task must not hide its old runs.
  const references = await db.execute<{ runs: number; pullRequests: number }>(sql`
    select count(distinct r.id)::int as runs,
      count(distinct p."pullRequest"->>'url') filter (where p."pullRequest" is not null)::int as "pullRequests"
    from agent_runs r left join run_publications p on p."runId" = r.id
    where (r."workspaceId" = ${team.workspaceId}::uuid
        or (r."workspaceId" is null and r."issueId" = any(${sql.param(scopedTaskIds)}::uuid[])))
      and (r."issueId" = any(${sql.param(scopedTaskIds)}::uuid[]) or r.cli_policy_hierarchy->>'teamId' = ${team.id})`)
  const runs = references.rows[0]?.runs ?? 0, pullRequests = references.rows[0]?.pullRequests ?? 0
  const impact: TeamDeletionImpact = {
    teamId: team.id, name: team.name, tasks: scopedTaskIds.length, projects: projectRows.filter(project => project.workspaceId === team.workspaceId).length, runs, pullRequests,
    archivedAt: team.archivedAt?.toISOString() ?? null,
    canDelete: !issueLinks.length && !projectLinks.length && !runs && !pullRequests,
    recovery: 'restore_archive',
  }
  return { issueLinks, projectLinks, members, taskRows, projectRows, impact }
}
type TeamContents = Awaited<ReturnType<typeof teamContents>>

async function recordLifecycle(tx: WorkspaceTransaction, team: typeof teams.$inferSelect, actorId: string, action: typeof teamLifecycleEvents.$inferInsert['action'], contents: TeamContents) {
  const id = crypto.randomUUID()
  await tx.insert(teamLifecycleEvents).values({ id, teamId: team.id, workspaceId: team.workspaceId, actorId, action, snapshot: {
    team: { name: team.name, identifier: team.identifier, archivedAt: team.archivedAt?.toISOString() ?? null, lastIssueNumber: team.lastIssueNumber },
    tasks: contents.issueLinks.map(link => ({ id: link.issueId, number: link.number })),
    projects: contents.projectLinks.map(link => ({ id: link.projectId, isPrimary: link.isPrimary })),
    members: contents.members, runs: contents.impact.runs, pullRequests: contents.impact.pullRequests,
  } })
  return id
}

/** All project links count, including projects collaborated on by several teams. */
export async function teamLifecycleImpact(actorId: string, teamId: string): Promise<TeamLifecycleImpact> {
  return workspaceDb.transaction(async tx => (await teamContents(tx, await lockTeam(tx, actorId, teamId))).impact)
}
export const teamDeletionImpact = teamLifecycleImpact

/** Archive keeps all grouping links, object IDs, published identities and history. */
export async function archiveTeamData(actorId: string, teamId: string): Promise<TeamLifecycleChange> {
  return workspaceDb.transaction(async tx => {
    const team = await lockTeam(tx, actorId, teamId)
    if (team.archivedAt) return { teamId: team.id, archivedAt: team.archivedAt.toISOString(), auditId: null }
    const auditId = await recordLifecycle(tx, team, actorId, 'archived', await teamContents(tx, team))
    const archivedAt = new Date()
    await tx.update(teams).set({ archivedAt, archivedBy: actorId, updatedAt: archivedAt }).where(eq(teams.id, team.id))
    await workspaceListChanged(tx, team.workspaceId, ['workspace_settings', 'issue_list'])
    return { teamId: team.id, archivedAt: archivedAt.toISOString(), auditId }
  })
}

/** Restoring an archive does not change any task/project or prior run snapshot. */
export async function restoreTeamData(actorId: string, teamId: string): Promise<TeamLifecycleChange> {
  return workspaceDb.transaction(async tx => {
    const team = await lockTeam(tx, actorId, teamId)
    if (!team.archivedAt) return { teamId: team.id, archivedAt: null, auditId: null }
    const auditId = await recordLifecycle(tx, team, actorId, 'restored', await teamContents(tx, team))
    await tx.update(teams).set({ archivedAt: null, archivedBy: null, updatedAt: new Date() }).where(eq(teams.id, team.id))
    await workspaceListChanged(tx, team.workspaceId, ['workspace_settings', 'issue_list'])
    return { teamId: team.id, archivedAt: null, auditId }
  })
}

async function removeGroupingRows(tx: WorkspaceTransaction, team: typeof teams.$inferSelect) {
  await tx.delete(teamIssueCreateReceipts).where(eq(teamIssueCreateReceipts.teamId, team.id))
  await tx.delete(teamIssuePromotionReceipts).where(eq(teamIssuePromotionReceipts.teamId, team.id))
  await tx.delete(teamIssues).where(eq(teamIssues.teamId, team.id))
  await tx.delete(teamProjects).where(eq(teamProjects.teamId, team.id))
  await tx.delete(teamMembers).where(eq(teamMembers.teamId, team.id))
  await tx.delete(teams).where(and(eq(teams.id, team.id), eq(teams.workspaceId, team.workspaceId)))
  await workspaceListChanged(tx, team.workspaceId, ['workspace_settings', 'issue_list'])
}

/** Explicit remove-grouping operation. Business objects and their histories stay. */
export async function removeTeamGroupingData(actorId: string, teamId: string, confirmName: string): Promise<TeamGroupingRemoval> {
  const typed = z.string().max(200).parse(confirmName).trim()
  let reviewIds: string[] = []
  try { return await workspaceDb.transaction(async tx => {
    const team = await lockTeam(tx, actorId, teamId)
    if (typed !== team.name) throw new WorkspaceError('teamDeleteNameMismatch')
    const contents = await teamContents(tx, team)
    // Never erase the only provenance of a legacy, unbound or conflicting object.
    if (contents.taskRows.some(task => task.ownershipState !== 'bound' || task.workspaceId !== team.workspaceId)
      || contents.projectRows.some(project => project.workspaceId !== team.workspaceId)
      || contents.issueLinks.some(link => link.workspaceId !== team.workspaceId)
      || contents.projectLinks.some(link => link.workspaceId !== team.workspaceId)) throw new WorkspaceError('teamLifecycleConflict')
    const auditId = await recordLifecycle(tx, team, actorId, 'grouping_removed', contents)
    if (contents.taskRows.length) reviewIds = await markReviewSessionsRevoked(pool,
      { taskIds: contents.taskRows.map(task => task.id) }, 'task_changed')
    await removeGroupingRows(tx, team)
    return { removed: { teamId: team.id, tasks: contents.impact.tasks, projects: contents.impact.projects }, auditId }
  }) } finally { await drainRevokedReviewSessions(pool, reviewIds) }
}

/**
 * This still means hard delete. A referenced team is explicitly refused instead
 * of silently reinterpreting a legacy delete request as archive/remove-grouping.
 * No recoverable business-object recycle bin exists, so only empty teams qualify.
 */
export async function deleteTeamData(actorId: string, teamId: string, confirmName: string): Promise<TeamDeletion> {
  const typed = z.string().max(200).parse(confirmName).trim()
  return workspaceDb.transaction(async tx => {
    const team = await lockTeam(tx, actorId, teamId)
    if (typed !== team.name) throw new WorkspaceError('teamDeleteNameMismatch')
    const contents = await teamContents(tx, team)
    if (!contents.impact.canDelete) throw new WorkspaceError('teamDeleteReferenced')
    const auditId = await recordLifecycle(tx, team, actorId, 'deleted', contents)
    await removeGroupingRows(tx, team)
    return { deleted: { tasks: 0, projects: 0 }, auditId }
  })
}

/** Admin-only journal remains discoverable after the team row has been removed. */
export async function readTeamLifecycleAudit(actorId: string, workspaceId: string, teamId: string) {
  z.uuid().parse(teamId)
  return workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, workspaceId, actorId, true)
    return tx.select().from(teamLifecycleEvents)
      .where(and(eq(teamLifecycleEvents.workspaceId, workspaceId), eq(teamLifecycleEvents.teamId, teamId)))
      .orderBy(desc(teamLifecycleEvents.createdAt)).limit(100)
  })
}
