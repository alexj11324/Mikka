'use server'
import { getTranslations } from 'next-intl/server'

import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { currentUser } from '@/lib/acting-user'
import { withDatabaseOperation } from '@/lib/db/egress-sample'
import { projectDb, projects, projectEvents } from '@/lib/db/projects'
import { requireIssueAccess } from '@/lib/issue-access'
import { updateIssueMetadata } from '@/app/actions/issue-metadata'
import { projectInput, projectPatch, hasDependencyCycle, type ProjectChanges } from '@/lib/project-input'
import { accessibleProjects, accessibleProjectReferences } from '@/lib/project-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { teamIssues, teamProjects } from '@/lib/db/team-schema'
import { inArray } from 'drizzle-orm'
import { lockTeamRelations } from '@/lib/team-access'
import { db, pool, withDatabaseTransaction } from '@/lib/db'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { withResourceAccess, lockResourcesAccess } from '@/lib/resource-access/store'
import { registerProjectAccess, bindProjectTasks } from '@/lib/resource-access/projects'
import type { IssueReader } from '@/lib/issue-visibility'
import { stopRunsForPolicyChange } from '@/lib/run-policy-stop'

async function projectUser() {
  const user = await currentUser()
  if (!user) throw new ActionFailureError('authRequired')
  return user
}
export async function listProjects() {
  return withDatabaseOperation('/actions/projects/list', async () => {
    const context = await loadWorkspaceContext()
    return (await accessibleProjects(await projectUser(), projectDb, context.workspace.id)).toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  })
}
async function persistProject(reader: Exclude<IssueReader, string>, input: unknown, partial: boolean) {
  const owner = reader.id
  const requestedId = typeof input === 'object' && input !== null && 'id' in input && typeof input.id === 'string' ? input.id : undefined
  const reference = requestedId ? (await accessibleProjectReferences(reader)).find(item => item.id === requestedId) : undefined
  if (requestedId && !reference) throw new ActionFailureError('issueNotFound')
  const workspaceId = reference?.workspaceId ?? (await loadWorkspaceContext()).workspace.id
  const i18nText = await getTranslations();
  try {
    return await withTaskWorkspace(reader, workspaceId, () => projectDb.transaction(async tx => {
      await lockTeamRelations(tx)
      if (reference) await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, reference.id)).for('update')
      const owned = await accessibleProjects(reader, tx, workspaceId)
      const patch = partial ? projectPatch.safeParse(input) : null
      if (patch && !patch.success) return { error: patch.error.issues[0]?.message ?? i18nText("Errors.issueMetadataInvalid") }
      const current = patch?.success ? owned.find(item => item.id === patch.data.id) : undefined
      if (patch?.success && !current) return { error: i18nText("Errors.projectNotFound") }
      const parsed = projectInput.safeParse(patch?.success ? { ...current, ...patch.data.changes, id: patch.data.id, revision: patch.data.revision } : input)
      if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? i18nText("Errors.projectCheckFields") }
      const { id, revision, ...values } = parsed.data
      if (id && (!revision || !owned.some(item => item.id === id && item.revision === revision))) return { error: i18nText("Errors.projectStale") }
      if (values.properties.dependencyIds.some(value => !owned.some(item => item.id === value))) return { error: i18nText("Errors.projectDependencyNotFound") }
      const projectOwner = id ? owned.find(item => item.id === id)!.userId : owner
      const links = id ? await tx.select().from(teamProjects).where(eq(teamProjects.projectId, id)) : []
      if (links.length && values.properties.dependencyIds.length) {
        const dependencies = await tx.select().from(teamProjects).where(inArray(teamProjects.projectId, values.properties.dependencyIds))
        if (values.properties.dependencyIds.some(dependencyId => !dependencies.some(link => link.projectId === dependencyId && link.workspaceId === links[0].workspaceId))) return { error: i18nText("FeatureCopy.c_63ed64ea") }
      }
      const nextId = id ?? crypto.randomUUID()
      if (hasDependencyCycle(nextId, values.properties.dependencyIds, owned)) return { error: i18nText("Errors.projectDependencyCycle") }
      const save = async () => {
      const [project] = id ? await tx.update(projects).set({ ...values, revision: revision! + 1, updatedAt: new Date() }).where(and(eq(projects.id, id), eq(projects.userId, projectOwner), eq(projects.revision, revision!))).returning() : await tx.insert(projects).values({ ...values, id: nextId, userId: owner, issueIds: [], revision: 1 }).returning()
      if (!project) return { error: i18nText("Errors.projectSaveConflict") }
      if (!id) await registerProjectAccess(reader, project.id, workspaceId)
      const names: Record<string, string> = { status: i18nText("Projects.fields.status"), priority: i18nText("Projects.fields.priority"), lead: i18nText("Projects.fields.lead"), startDate: i18nText("Projects.fields.startDate"), targetDate: i18nText("Projects.fields.targetDate"), properties: i18nText("Projects.detail.detailsLabel"), name: i18nText("Settings.workspaceForm.name"), summary: i18nText("Projects.fields.summary"), description: i18nText("Projects.form.descriptionHeading"), team: i18nText("Settings.sections.teams.title") }
      const message = patch?.success ? i18nText("FeatureCopy.c_976c2152", { value0: (Object.keys(patch.data.changes).map(key => names[key]).join('、')) }) : id ? i18nText("Projects.activity.updatedOverview") : i18nText("Projects.activity.created")
      await tx.insert(projectEvents).values({ id: crypto.randomUUID(), userId: projectOwner, projectId: project.id, message })
      await (await import('@/lib/live/project-map')).projectMapChanged(tx, project.id)
      return { project }
      }
      return reference ? withResourceAccess(reader, reference, 'canSteer', save) : save()
    }))
  } catch (error) {
    if (error instanceof ActionFailureError) throw error
    return { error: i18nText("Errors.projectSaveFailed") }
  }
}
export async function saveProject(input: z.input<typeof projectInput>) {
  return persistProject(await projectUser(), input, false)
}
export async function updateProjectProperties(input: { id: string; revision: number; changes: ProjectChanges }) {
  return persistProject(await projectUser(), input, true)
}
export async function moveIssueToProject(input: { issueId: string; revision: number; projectId: string | null }) {
  const i18nText = await getTranslations()
  const reader = await projectUser()
  const parsed = z.object({ issueId: z.uuid(), revision: z.number().int().positive(), projectId: z.uuid().nullable() }).safeParse(input)
  if (!parsed.success) return { error: i18nText("Errors.projectMoveInvalid") }
  const { issue } = await requireIssueAccess(input.issueId)
  if (!issue.workspaceId) throw new ActionFailureError('issueNotFound')
  const workspaceId = issue.workspaceId
  try {
    return await withTaskWorkspace(reader, workspaceId, () => projectDb.transaction(async tx => {
      await lockTeamRelations(tx)
      const references = await accessibleProjectReferences(reader, workspaceId)
      const owned = references.length ? await tx.select().from(projects).where(inArray(projects.id, references.map(row => row.id))).orderBy(projects.id).for('update') : []
      const destination = owned.find(project => project.id === input.projectId)
      if (input.projectId && !destination) return { error: i18nText("Errors.projectNotFound") }
      if (destination && !destination.issueIds.includes(input.issueId) && destination.issueIds.length >= 100) return { error: i18nText("Errors.projectTaskLimit") }
      const previousProject = owned.find(project => project.issueIds.includes(input.issueId))
      const affected = owned.filter(project => project.issueIds.includes(input.issueId) || project.id === input.projectId)
        .sort((left, right) => Number(left.id === input.projectId) - Number(right.id === input.projectId))
      return db.transaction(app => withDatabaseTransaction(app, async () => {
        await lockResourcesAccess(app, reader.id, [
          ...affected.map(project => ({ reference: { kind: 'project' as const, id: project.id, workspaceId }, action: 'canSteer' as const })),
          { reference: { kind: 'task' as const, id: issue.id, workspaceId }, action: 'canManageAccess' as const },
        ], true)
        const result = await updateIssueMetadata({ id: input.issueId, revision: input.revision, patch: { project: destination?.name ?? null } })
        if (!('issue' in result) || !result.issue) return result
        if ((previousProject?.id ?? null) !== input.projectId) await stopRunsForPolicyChange(pool, { kind: 'task', issueId: input.issueId })
        for (const project of affected) {
          const issueIds = project.id === input.projectId ? [...new Set([...project.issueIds, input.issueId])] : project.issueIds.filter(id => id !== input.issueId)
          await bindProjectTasks(app, reader, { kind: 'project', id: project.id, workspaceId }, project.issueIds, issueIds)
          await tx.update(projects).set({ issueIds, revision: project.revision + 1, updatedAt: new Date() }).where(and(eq(projects.id, project.id), eq(projects.userId, project.userId)))
          await tx.insert(projectEvents).values({ id: crypto.randomUUID(), userId: project.userId, projectId: project.id, message: project.id === input.projectId ? i18nText("Projects.activity.tasksAdded") : i18nText("Projects.activity.tasksRemoved") })
          await (await import('@/lib/live/project-map')).projectMapChanged(tx, project.id)
        }
        return result
      }))
    }))
  } catch (error) {
    if (error instanceof ActionFailureError) throw error
    return { error: i18nText("Errors.projectMoveFailed") }
  }
}

export async function listProjectEvents(id: string) {
  const i18nText = await getTranslations();
  const reader = await projectUser()
  z.uuid().parse(id)
  const project = (await accessibleProjects(reader)).find(item => item.id === id)
  if (!project) throw new Error(i18nText("FeatureCopy.c_bf32df66"))
  return projectDb.select().from(projectEvents).where(and(eq(projectEvents.projectId, id), eq(projectEvents.userId, project.userId))).orderBy(desc(projectEvents.createdAt)).limit(100)
}
export async function setProjectIssues(input: { id: string; revision: number; issueIds: string[] }) {
  const i18nText = await getTranslations();
  const reader = await projectUser()
  const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), issueIds: z.array(z.uuid()).max(100) }).safeParse(input)
  if (!parsed.success) return { error: i18nText("Errors.projectIssuesInvalid") }
  const ids = [...new Set(parsed.data.issueIds)]
  try {
    for (const id of ids) await requireIssueAccess(id)
    const reference = (await accessibleProjectReferences(reader)).find(item => item.id === input.id)
    if (!reference) throw new ActionFailureError('issueNotFound')
    return await withTaskWorkspace(reader, reference.workspaceId, () => projectDb.transaction(async tx => {
      await lockTeamRelations(tx)
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, input.id)).for('update')
      const owned = await accessibleProjects(reader, tx, reference.workspaceId)
      const current = owned.find(project => project.id === input.id)
      if (!current) return { error: i18nText("Errors.projectNotFound") }
      const links = await tx.select().from(teamProjects).where(eq(teamProjects.projectId, current.id))
      const taskLinks = ids.length ? await tx.select().from(teamIssues).where(inArray(teamIssues.issueId, ids)) : []
      if (links.length && ids.some(id => !taskLinks.some(link => link.issueId === id && links.some(team => team.teamId === link.teamId)))) return { error: i18nText("FeatureCopy.c_bea413fd") }
      if (ids.length) {
        const conflicts = await tx.select({ id: projects.id }).from(projects).where(and(sql`${projects.id} <> ${current.id}`, sql`${projects.issueIds} ?| array[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]`)).limit(1)
        if (conflicts.length) return { error: i18nText("Errors.projectIssueAlreadyLinked") }
      }
      if (current.revision !== input.revision) return { error: i18nText("Errors.projectSaveConflict") }
      return withResourceAccess(reader, reference, 'canSteer', () => db.transaction(app => withDatabaseTransaction(app, async () => {
      await bindProjectTasks(app, reader, reference, current.issueIds, ids)
      const [project] = await tx.update(projects).set({ issueIds: ids, revision: input.revision + 1, updatedAt: new Date() }).where(and(eq(projects.id, input.id), eq(projects.userId, current.userId), eq(projects.revision, input.revision))).returning()
      if (!project) return { error: i18nText("Errors.projectSaveConflict") }
      const changedIssues = [...new Set([...current.issueIds, ...ids])].filter(id => current.issueIds.includes(id) !== ids.includes(id))
      if (changedIssues.length) await stopRunsForPolicyChange(pool, { kind: 'tasks', issueIds: changedIssues })
      await tx.insert(projectEvents).values({ id: crypto.randomUUID(), userId: current.userId, projectId: project.id, message: i18nText("FeatureCopy.c_310e5541", { value0: (ids.length) }) })
      await (await import('@/lib/live/project-map')).projectMapChanged(tx, project.id)
      return { project }
      })))
    }))
  } catch (error) {
    if (error instanceof ActionFailureError) throw error
    return { error: i18nText("Errors.projectIssuesSaveFailed") }
  }
}
