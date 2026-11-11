'use server'
import { getTranslations } from 'next-intl/server'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { requireIssueAccess, requireUser } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues, teamProjects } from '@/lib/db/team-schema'
import { projects, projectEvents } from '@/lib/db/projects'
import { accessibleProjects, accessibleProjectReferences, requireProjectWrite } from '@/lib/project-access'
import { lockTeamRelations, requireActiveTeam } from '@/lib/team-access'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { withResourceAccess } from '@/lib/resource-access/store'
import { ActionFailureError } from '@/lib/action-error'
import { issueListScopesBeforeChange, issueListScopeChanged } from '@/lib/live/lists'
import { notifyStoppedPolicyRuns, runPolicyStopSQL, type StoppedPolicyRun } from '@/lib/run-policy-stop'

async function result<T>(operation: () => Promise<T>) {
  const t = await getTranslations()
  try { return { ok: true as const, data: await operation() } }
  catch (error) {
    if (error instanceof ActionFailureError) return { ok: false as const, code: error.code, error: t(`Errors.${error.code}`) }
    if (error instanceof WorkspaceError) return { ok: false as const, error: error.message }
    if (error instanceof z.ZodError) return { ok: false as const, error: t('Errors.issueMetadataInvalid') }
    throw error
  }
}
export async function getIssueTeam(id: string) { return (await requireIssueAccess(id)).teamId }
export async function setIssueTeam(input: { issueId: string; teamId: string | null; expectedTeamId: string | null }) {
  return result(async () => {
    z.object({ issueId: z.uuid(), teamId: z.uuid().nullable(), expectedTeamId: z.uuid().nullable() }).parse(input)
    const { issue, user } = await requireIssueAccess(input.issueId)
    if (!issue.workspaceId || issue.ownershipState !== 'bound') throw new ActionFailureError('workspaceAccessDenied')
    return withTaskWorkspace(user, issue.workspaceId, async (workspace, tx) => {
      await lockTeamRelations(tx)
      const [current] = await tx.select().from(teamIssues).where(eq(teamIssues.issueId, issue.id)).limit(1)
      if ((current?.teamId ?? null) !== input.expectedTeamId) throw new ActionFailureError('teamIssueChanged')
      if (current && current.workspaceId !== workspace.id) throw new ActionFailureError('workspaceAccessDenied')
      const destination = input.teamId ? await requireActiveTeam(tx, input.teamId, user.id, false, workspace.id) : null
      if (destination && (workspace.kind === 'personal' || destination.workspaceId !== workspace.id)) throw new ActionFailureError('workspaceAccessDenied')
      // Project collaboration Teams are independent of the task's optional grouping.
      return withResourceAccess(user, { kind: 'task', id: issue.id, workspaceId: workspace.id }, 'canSteer', async (_policy, app) => {
        const previousLists = await issueListScopesBeforeChange(issue)
        if ((current?.teamId ?? null) !== (destination?.id ?? null)) {
          const stopped = await app.execute<StoppedPolicyRun>(runPolicyStopSQL({ kind: 'task', issueId: issue.id }))
          notifyStoppedPolicyRuns(app, stopped.rows)
        }
        if (destination) await tx.insert(teamIssues).values({ issueId: issue.id, teamId: destination.id, workspaceId: workspace.id, userId: issue.userId })
          .onConflictDoUpdate({ target: teamIssues.issueId, set: { teamId: destination.id, workspaceId: workspace.id } })
        else await tx.delete(teamIssues).where(eq(teamIssues.issueId, issue.id))
        if (current?.teamId !== destination?.id) await issueListScopeChanged(tx, issue.id, previousLists)
        return input.teamId
      })
    })
  })
}
export async function listProjectTeams() {
  const user = await requireUser()
  const { workspace } = await loadWorkspaceContext(undefined, user)
  return withTaskWorkspace(user, workspace.id, async () => {
    const allowed = await accessibleProjects(user, workspaceDb, workspace.id)
    return allowed.length ? workspaceDb.select().from(teamProjects).where(and(eq(teamProjects.workspaceId, workspace.id), inArray(teamProjects.projectId, allowed.map(project => project.id)))) : []
  })
}
export async function setProjectTeams(input: { projectId: string; revision: number; teamIds: string[]; primaryTeamId: string | null }) {
  return result(async () => {
    const parsed = z.object({ projectId: z.uuid(), revision: z.number().int().positive(), teamIds: z.array(z.uuid()).max(100), primaryTeamId: z.uuid().nullable() }).parse(input)
    const ids = [...new Set(parsed.teamIds)]
    if (parsed.primaryTeamId && !ids.includes(parsed.primaryTeamId)) throw new ActionFailureError('issueMetadataInvalid')
    const user = await requireUser()
    const { workspace } = await loadWorkspaceContext(undefined, user)
    const reference = (await accessibleProjectReferences(user, workspace.id)).find(item => item.id === parsed.projectId)
    if (!reference) throw new ActionFailureError('projectNotFound')
    return withTaskWorkspace(user, workspace.id, async (tenant, tx) => {
      await lockTeamRelations(tx)
      const project = await requireProjectWrite(tx, user, parsed.projectId, tenant.id)
      if (project.revision !== parsed.revision) throw new ActionFailureError('projectStale')
      if (tenant.kind === 'personal' && ids.length) throw new ActionFailureError('workspaceAccessDenied')
      for (const id of ids) {
        const team = await requireActiveTeam(tx, id, user.id, false, tenant.id)
        if (team.workspaceId !== tenant.id) throw new ActionFailureError('workspaceAccessDenied')
      }
      return withResourceAccess(user, reference, 'canSteer', async () => {
        const [updated] = await tx.update(projects).set({ revision: parsed.revision + 1, updatedAt: new Date() })
          .where(and(eq(projects.id, project.id), eq(projects.workspaceId, tenant.id), eq(projects.revision, parsed.revision))).returning()
        if (!updated) throw new ActionFailureError('projectStale')
        await tx.delete(teamProjects).where(eq(teamProjects.projectId, project.id))
        if (ids.length) await tx.insert(teamProjects).values(ids.map(teamId => ({ projectId: project.id, teamId, workspaceId: tenant.id, userId: project.userId, isPrimary: teamId === parsed.primaryTeamId })))
        const t = await getTranslations()
        await tx.insert(projectEvents).values({ id: crypto.randomUUID(), projectId: project.id, userId: user.id, message: ids.length ? t('FeatureCopy.c_7cc606e0') : t('FeatureCopy.c_c8d00bc5') })
        await (await import('@/lib/live/project-map')).projectMapChanged(tx, project.id)
        return (await accessibleProjects(user, tx, tenant.id)).find(item => item.id === project.id)!
      })
    })
  })
}
