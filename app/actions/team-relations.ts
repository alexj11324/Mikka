'use server'
import { getTranslations } from 'next-intl/server'

import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireIssueAccess, requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues, teamProjects } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { projects, projectEvents } from '@/lib/db/projects'
import { accessibleProjects } from '@/lib/project-access'
import { lockTeamRelations, requireTeam } from '@/lib/team-access'
import { WorkspaceError } from '@/lib/workspace-access'

async function result<T>(operation: () => Promise<T>) {
  const i18nText = await getTranslations();
  try { return { ok: true as const, data: await operation() } }
  catch (error) {
    return { ok: false as const, error: error instanceof WorkspaceError ? error.message : i18nText("FeatureCopy.c_6dfc6360") }
  }
}
export async function getIssueTeam(id: string) { return (await requireIssueAccess(id)).teamId }
export async function setIssueTeam(input: { issueId: string; teamId: string | null; expectedTeamId: string | null }) {
  const i18nText = await getTranslations();
  return result(async () => {
    z.object({ issueId: z.uuid(), teamId: z.uuid().nullable(), expectedTeamId: z.uuid().nullable() }).parse(input)
    const { issue, user } = await requireIssueAccess(input.issueId)
    return workspaceDb.transaction(async tx => {
      await lockTeamRelations(tx)
      const [current] = await tx.select().from(teamIssues).where(eq(teamIssues.issueId, issue.id)).limit(1)
      if ((current?.teamId ?? null) !== input.expectedTeamId) throw new WorkspaceError(i18nText("FeatureCopy.c_f07cbdb4"))
      if (current) await requireTeam(tx, current.teamId, user.id, issue.userId !== user.id)
      else if (issue.userId !== user.id) throw new WorkspaceError(i18nText("FeatureCopy.c_ea537eb1"))
      const destination = input.teamId ? await requireTeam(tx, input.teamId, user.id) : null
      if (current && destination && current.workspaceId !== destination.workspaceId) throw new WorkspaceError(i18nText("FeatureCopy.c_c6ea7195"))
      const containing = await tx.select({ id: projects.id }).from(projects).where(sql`${projects.issueIds} @> ${JSON.stringify([issue.id])}::jsonb`)
      if (containing.length) {
        const links = await tx.select().from(teamProjects).where(inArray(teamProjects.projectId, containing.map(project => project.id)))
        if (links.length && (!destination || !links.some(link => link.teamId === destination.id))) throw new WorkspaceError(i18nText("FeatureCopy.c_482418a8"))
      }
      if (destination) await tx.insert(teamIssues).values({ issueId: issue.id, teamId: destination.id, workspaceId: destination.workspaceId, userId: issue.userId }).onConflictDoUpdate({ target: teamIssues.issueId, set: { teamId: destination.id, workspaceId: destination.workspaceId } })
      else await tx.delete(teamIssues).where(and(eq(teamIssues.issueId, issue.id), eq(teamIssues.userId, issue.userId)))
      return input.teamId
    })
  })
}
export async function listProjectTeams() {
  const user = await requireUser()
  const allowed = await accessibleProjects(user.id)
  return allowed.length ? workspaceDb.select().from(teamProjects).where(inArray(teamProjects.projectId, allowed.map(project => project.id))) : []
}
export async function setProjectTeams(input: { projectId: string; revision: number; teamIds: string[]; primaryTeamId: string | null }) {
  const i18nText = await getTranslations();
  return result(async () => {
    const parsed = z.object({ projectId: z.uuid(), revision: z.number().int().positive(), teamIds: z.array(z.uuid()).max(20), primaryTeamId: z.uuid().nullable() }).parse(input)
    const ids = [...new Set(parsed.teamIds)]
    if (ids.length && (!parsed.primaryTeamId || !ids.includes(parsed.primaryTeamId))) throw new WorkspaceError(i18nText("FeatureCopy.c_2be374e2"))
    if (!ids.length && parsed.primaryTeamId) throw new WorkspaceError(i18nText("FeatureCopy.c_9aa6ec13"))
    const user = await requireUser()
    return workspaceDb.transaction(async tx => {
      await lockTeamRelations(tx)
      const accessible = await accessibleProjects(user.id, tx)
      const project = accessible.find(item => item.id === parsed.projectId)
      if (!project) throw new WorkspaceError(i18nText("FeatureCopy.c_bf32df66"))
      const current = await tx.select().from(teamProjects).where(eq(teamProjects.projectId, project.id))
      if (project.userId !== user.id) {
        if (!current.length) throw new WorkspaceError(i18nText("FeatureCopy.c_8f941499"))
        await requireTeam(tx, current[0].teamId, user.id, true)
      }
      const destinations = []
      for (const id of ids) destinations.push(await requireTeam(tx, id, user.id))
      const workspaceId = destinations[0]?.workspaceId ?? current[0]?.workspaceId
      if (destinations.some(team => team.workspaceId !== workspaceId) || current.some(link => link.workspaceId !== workspaceId)) throw new WorkspaceError(i18nText("FeatureCopy.c_7df8967f"))
      if (!ids.length && current.length) {
        const dependents = await tx.select({ id: projects.id }).from(projects).innerJoin(teamProjects, eq(teamProjects.projectId, projects.id)).where(sql`${projects.properties}->'dependencyIds' @> ${JSON.stringify([project.id])}::jsonb`).limit(1)
        if (dependents.length) throw new WorkspaceError(i18nText("FeatureCopy.c_cb791320"))
      }
      const issueLinks = project.issueIds.length ? await tx.select().from(teamIssues).where(inArray(teamIssues.issueId, project.issueIds)) : []
      if (ids.length && project.issueIds.some(id => !issueLinks.some(link => link.issueId === id && ids.includes(link.teamId)))) throw new WorkspaceError(i18nText("FeatureCopy.c_71dc715f"))
      if (ids.length && project.properties.dependencyIds.length) {
        const dependencyLinks = await tx.select().from(teamProjects).where(inArray(teamProjects.projectId, project.properties.dependencyIds))
        if (project.properties.dependencyIds.some(id => !dependencyLinks.some(link => link.projectId === id && link.workspaceId === workspaceId))) throw new WorkspaceError(i18nText("FeatureCopy.c_56c2aeab"))
      }
      if (workspaceId) {
        const [member] = await tx.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active')))
        if (!member) throw new WorkspaceError(i18nText("FeatureCopy.c_88f0e879"))
      }
      const [updated] = await tx.update(projects).set({ revision: parsed.revision + 1, updatedAt: new Date() }).where(and(eq(projects.id, project.id), eq(projects.userId, project.userId), eq(projects.revision, parsed.revision))).returning()
      if (!updated) throw new WorkspaceError(i18nText("FeatureCopy.c_d260e378"))
      await tx.delete(teamProjects).where(and(eq(teamProjects.projectId, project.id), eq(teamProjects.userId, project.userId)))
      if (ids.length) await tx.insert(teamProjects).values(ids.map(teamId => ({ projectId: project.id, teamId, workspaceId: workspaceId!, userId: project.userId, isPrimary: teamId === parsed.primaryTeamId })))
      await tx.insert(projectEvents).values({ id: crypto.randomUUID(), projectId: project.id, userId: project.userId, message: ids.length ? i18nText("FeatureCopy.c_7cc606e0") : i18nText("FeatureCopy.c_c8d00bc5") })
      return updated
    })
  })
}
