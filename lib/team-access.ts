import { getTranslations } from 'next-intl/server'
import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { teams, teamMembers } from '@/lib/db/team-schema'
import { WorkspaceError, type WorkspaceTransaction } from '@/lib/workspace-access'

export async function accessibleTeams(userId: string, workspaceId?: string) {
  return workspaceDb.select({ id: teams.id, workspaceId: teams.workspaceId, name: teams.name, identifier: teams.identifier, description: teams.description, workspaceRole: workspaceMembers.role, role: teamMembers.role })
    .from(teams).innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, teams.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .leftJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, userId)))
    .where(workspaceId ? eq(teams.workspaceId, workspaceId) : undefined).orderBy(teams.createdAt)
}
export async function requireTeam(tx: WorkspaceTransaction, id: string, userId: string, manage = false) {
  const i18nText = await getTranslations();
  z.uuid().parse(id)
  const [team] = await tx.select({ id: teams.id, workspaceId: teams.workspaceId, name: teams.name, admin: workspaceMembers.role }).from(teams)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, teams.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .where(eq(teams.id, id)).for('update').limit(1)
  if (!team) throw new WorkspaceError(i18nText("FeatureCopy.c_f061da49"))
  const [membership] = await tx.select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId))).limit(1)
  if (manage && team.admin !== 'admin' && membership?.role !== 'owner') throw new WorkspaceError(i18nText("FeatureCopy.c_3a2b2e58"))
  return { ...team, role: membership?.role ?? null }
}
export async function lockTeamRelations(tx: WorkspaceTransaction) {
  // Tasks and projects share a relation lock because their records live in separate databases.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('orvilo-team-relations', 0))`)
}
