import { getTranslations } from 'next-intl/server'
import 'server-only'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaces, workspaceMembers } from '@/lib/db/workspace-schema'
import { teams, teamMembers } from '@/lib/db/team-schema'
import { requireWorkspace, WorkspaceError, type WorkspaceTransaction } from '@/lib/workspace-access'

export type TeamScope = { id: string; workspaceId: string }

/** Permission identity for reads that do not display team settings. */
export async function accessibleTeamScopes(userId: string, workspaceId?: string): Promise<TeamScope[]> {
  return workspaceDb.select({ id: teams.id, workspaceId: teams.workspaceId }).from(teams)
    .innerJoin(workspaceMembers, and(
      eq(workspaceMembers.workspaceId, teams.workspaceId),
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.status, 'active'),
    ))
    .where(workspaceId ? eq(teams.workspaceId, workspaceId) : undefined)
    .orderBy(teams.createdAt)
}

export async function accessibleTeams(userId: string, workspaceId?: string, options: { includeArchived?: boolean } = {}) {
  return workspaceDb.select({ id: teams.id, workspaceId: teams.workspaceId, name: teams.name, identifier: teams.identifier, description: teams.description, archivedAt: teams.archivedAt, workspaceRole: workspaceMembers.role, role: teamMembers.role })
    .from(teams).innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, teams.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .innerJoin(workspaces, and(eq(workspaces.id, teams.workspaceId), eq(workspaces.kind, 'team')))
    .leftJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, userId)))
    .where(and(workspaceId ? eq(teams.workspaceId, workspaceId) : undefined, options.includeArchived ? undefined : isNull(teams.archivedAt))).orderBy(teams.createdAt)
}
export async function requireTeam(tx: WorkspaceTransaction, id: string, userId: string, manage = false) {
  const i18nText = await getTranslations();
  z.uuid().parse(id)
  const [scope] = await tx.select({ workspaceId: teams.workspaceId }).from(teams).where(eq(teams.id, id)).limit(1)
  if (!scope) throw new WorkspaceError(i18nText("FeatureCopy.c_f061da49"))
  // Reads already held a Team lock; take the tenant/member and relation locks
  // first so member management cannot deadlock lifecycle/project mutations.
  const { workspace } = await requireWorkspace(tx, scope.workspaceId, userId)
  await lockTeamRelations(tx)
  const [team] = await tx.select({ id: teams.id, workspaceId: teams.workspaceId, name: teams.name, archivedAt: teams.archivedAt, admin: workspaceMembers.role }).from(teams)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, teams.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .where(and(eq(teams.id, id), eq(teams.workspaceId, scope.workspaceId))).for('update').limit(1)
  if (!team) throw new WorkspaceError(i18nText("FeatureCopy.c_f061da49"))
  const [membership] = await tx.select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId))).limit(1)
  if (manage && team.admin !== 'admin' && membership?.role !== 'owner') throw new WorkspaceError(i18nText("FeatureCopy.c_3a2b2e58"))
  return { ...team, workspaceKind: workspace.kind, role: membership?.role ?? null }
}

/** Archive preserves read access, but cannot receive new work or members. */
export async function requireActiveTeam(tx: WorkspaceTransaction, id: string, userId: string, manage = false) {
  const team = await requireTeam(tx, id, userId, manage)
  if (team.workspaceKind === 'personal') throw new WorkspaceError('teamPersonalWorkspace')
  if (team.archivedAt) throw new WorkspaceError('teamArchived')
  return team
}
export async function lockTeamRelations(tx: WorkspaceTransaction) {
  // Tasks and projects share a relation lock because their records live in separate databases.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('mikka-team-relations', 0))`)
}
