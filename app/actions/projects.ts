'use server'

import { headers } from 'next/headers'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionErrorCode } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { projectDb, projects, projectEvents } from '@/lib/db/projects'
import { requireIssueAccess } from '@/lib/issue-access'
import { updateIssueMetadata } from '@/app/actions/issue-metadata'
import { projectInput, projectPatch, hasDependencyCycle, type ProjectChanges } from '@/lib/project-input'

const PROJECT_VALIDATION_CODES = new Set<string>(['validationProjectNameRequired', 'validationProjectMilestoneName', 'validationProjectDuplicate', 'validationProjectMilestoneDuplicate', 'validationProjectDateOrder', 'validationProjectChangesRequired'])

function failure(error: string) {
  return { error: error as ActionErrorCode }
}

function validationFailure(error: z.ZodError, fallback: string) {
  const message = error.issues[0]?.message
  return failure(message && PROJECT_VALIDATION_CODES.has(message) ? message : fallback)
}

async function userId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}
export async function listProjects() {
  const owner = await userId()
  return projectDb.select().from(projects).where(eq(projects.userId, owner)).orderBy(desc(projects.updatedAt))
}
async function persistProject(owner: string, input: unknown, partial: boolean) {
  try {
    return await projectDb.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${owner}, 0))`)
      const owned = await tx.select().from(projects).where(eq(projects.userId, owner))
      const patch = partial ? projectPatch.safeParse(input) : null
      if (patch && !patch.success) return validationFailure(patch.error, 'projectPropertyInvalid')
      const current = patch?.success ? owned.find(item => item.id === patch.data.id) : undefined
      if (patch?.success && !current) return failure('projectNotFound')
      const parsed = projectInput.safeParse(patch?.success ? { ...current, ...patch.data.changes, id: patch.data.id, revision: patch.data.revision } : input)
      if (!parsed.success) return validationFailure(parsed.error, 'projectCheckFields')
      const { id, revision, ...values } = parsed.data
      if (id && (!revision || !owned.some(item => item.id === id && item.revision === revision))) return failure('projectStale')
      if (values.properties.dependencyIds.some(value => !owned.some(item => item.id === value))) return failure('projectDependencyNotFound')
      const nextId = id ?? crypto.randomUUID()
      if (hasDependencyCycle(nextId, values.properties.dependencyIds, owned)) return failure('projectDependencyCycle')
      const [project] = id ? await tx.update(projects).set({ ...values, revision: revision! + 1, updatedAt: new Date() }).where(and(eq(projects.id, id), eq(projects.userId, owner), eq(projects.revision, revision!))).returning() : await tx.insert(projects).values({ ...values, id: nextId, userId: owner, issueIds: [], revision: 1 }).returning()
      if (!project) return failure('projectSaveConflict')
      const message = patch?.success ? `project.updatedFields:${Object.keys(patch.data.changes).join(',')}` : id ? 'project.updated' : 'project.created'
      await tx.insert(projectEvents).values({ id: crypto.randomUUID(), userId: owner, projectId: project.id, message })
      return { project }
    })
  } catch { return failure('projectSaveFailed') }
}
export async function saveProject(input: z.input<typeof projectInput>) {
  return runAction(async () => persistProject(await userId(), input, false))
}
export async function updateProjectProperties(input: { id: string; revision: number; changes: ProjectChanges }) {
  return runAction(async () => persistProject(await userId(), input, true))
}
export async function moveIssueToProject(input: { issueId: string; revision: number; projectId: string | null }) {
  return runAction(async () => {
    const owner = await userId()
    const parsed = z.object({ issueId: z.uuid(), revision: z.number().int().positive(), projectId: z.uuid().nullable() }).safeParse(input)
    if (!parsed.success) return failure('projectMoveInvalid')
    await requireIssueAccess(input.issueId)
    try {
      return await projectDb.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${owner}, 0))`)
        const owned = await tx.select().from(projects).where(eq(projects.userId, owner)).for('update')
        const destination = owned.find(project => project.id === input.projectId)
        if (input.projectId && !destination) return failure('projectNotFound')
        if (destination && !destination.issueIds.includes(input.issueId) && destination.issueIds.length >= 100) return failure('projectTaskLimit')
        const result = await updateIssueMetadata({ id: input.issueId, revision: input.revision, patch: { project: destination?.name ?? null } })
        if (!('issue' in result) || !result.issue) return result
        for (const project of owned.filter(project => project.issueIds.includes(input.issueId) || project.id === input.projectId)) {
          const issueIds = project.id === input.projectId ? [...new Set([...project.issueIds, input.issueId])] : project.issueIds.filter(id => id !== input.issueId)
          await tx.update(projects).set({ issueIds, revision: project.revision + 1, updatedAt: new Date() }).where(and(eq(projects.id, project.id), eq(projects.userId, owner)))
          await tx.insert(projectEvents).values({ id: crypto.randomUUID(), userId: owner, projectId: project.id, message: project.id === input.projectId ? 'project.tasksAdded' : 'project.tasksRemoved' })
        }
        return result
      })
    } catch { return failure('projectMoveFailed') }
  })
}

export async function listProjectEvents(id: string) {
  const owner = await userId()
  z.uuid().parse(id)
  return projectDb.select().from(projectEvents).where(and(eq(projectEvents.projectId, id), eq(projectEvents.userId, owner))).orderBy(desc(projectEvents.createdAt)).limit(100)
}
export async function setProjectIssues(input: { id: string; revision: number; issueIds: string[] }) {
  return runAction(async () => {
    const owner = await userId()
    const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), issueIds: z.array(z.uuid()).max(100) }).safeParse(input)
    if (!parsed.success) return failure('projectIssuesInvalid')
    const ids = [...new Set(parsed.data.issueIds)]
    for (const id of ids) await requireIssueAccess(id)
    try {
      return await projectDb.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${owner}, 0))`)
        const owned = await tx.select().from(projects).where(eq(projects.userId, owner))
        if (owned.some(project => project.id !== input.id && project.issueIds.some(id => ids.includes(id)))) return failure('projectIssueAlreadyLinked')
        const [project] = await tx.update(projects).set({ issueIds: ids, revision: input.revision + 1, updatedAt: new Date() }).where(and(eq(projects.id, input.id), eq(projects.userId, owner), eq(projects.revision, input.revision))).returning()
        if (!project) return failure('projectStale')
        await tx.insert(projectEvents).values({ id: crypto.randomUUID(), userId: owner, projectId: project.id, message: `project.tasksUpdated:${ids.length}` })
        return { project }
      })
    } catch { return failure('projectIssuesSaveFailed') }
  })
}
