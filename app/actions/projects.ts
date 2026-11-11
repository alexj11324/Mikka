'use server'
import { getTranslations } from 'next-intl/server'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { withDatabaseOperation } from '@/lib/db/egress-sample'
import { projectDb, projects, projectEvents, projectTasks, projectMembers } from '@/lib/db/projects'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { issues, issueVersions } from '@/lib/db/schema'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/issue-access'
import { issueVisibilityPredicate } from '@/lib/issue-visibility-policy'
import { issueView } from '@/lib/task-identifier-server'
import { activityActor } from '@/lib/activity-actor'
import { issueListChanged } from '@/lib/live/lists'
import { projectInput, projectPatch, projectPeople, hasDependencyCycle, type ProjectChanges } from '@/lib/project-input'
import { accessibleProjects, accessibleProjectReferences, requireProjectWrite, type ProjectTransaction } from '@/lib/project-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { lockTeamRelations } from '@/lib/team-access'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { withResourceAccess, lockResourcesAccess } from '@/lib/resource-access/store'
import { registerProjectAccess, bindProjectTasks } from '@/lib/resource-access/projects'
import { assertAccessConfirmation } from '@/lib/resource-access/confirm-access'
import { notifyStoppedPolicyRuns, runPolicyStopSQL, type StoppedPolicyRun } from '@/lib/run-policy-stop'
import { deleteProjectData, projectLifecycleImpact, setProjectArchive } from '@/lib/project-lifecycle'

const batchSize = 200

async function projectContext(workspaceId?: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(workspaceId, user)
  return { user, workspaceId: context.workspace.id }
}

/** These locks precede the relation lock, just like Workspace membership edits. */
async function lockPeople(tx: ProjectTransaction, workspaceId: string, people: ReturnType<typeof projectPeople>) {
  const ids = [...new Set([people.leadUserId, ...people.memberIds].filter((id): id is string => Boolean(id)))].sort()
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize)
    const members = await tx.select({ id: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active'), inArray(workspaceMembers.userId, batch)))
      .orderBy(asc(workspaceMembers.userId)).for('share')
    if (members.length !== batch.length) throw new ActionFailureError('memberNotJoined')
  }
}

async function emitProjectChange(tx: ProjectTransaction, projectId: string, actorId: string, message: string) {
  await tx.insert(projectEvents).values({ id: crypto.randomUUID(), userId: actorId, projectId, message })
  await (await import('@/lib/live/project-map')).projectMapChanged(tx, projectId)
}

async function readProject(tx: ProjectTransaction | typeof projectDb, reader: Parameters<typeof accessibleProjects>[0], workspaceId: string, projectId: string) {
  const [project] = await accessibleProjects(reader, tx, workspaceId, projectId)
  if (!project) throw new ActionFailureError('projectNotFound')
  return project
}

async function projectsInContext(workspaceId?: string) {
  return withDatabaseOperation('/actions/projects/list', async () => {
    const context = await projectContext(workspaceId)
    return (await accessibleProjects(context.user, projectDb, context.workspaceId)).toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  })
}

/** Retain the zero-argument action signature: existing SWR consumers pass
 * their cache key to the fetcher, which generated clients must discard. */
export async function listProjects() {
  return projectsInContext()
}

export async function listWorkspaceProjects(workspaceId: string) {
  return projectsInContext(workspaceId)
}

async function persistProject(input: unknown, partial: boolean) {
  const i18nText = await getTranslations()
  const patch = partial ? projectPatch.safeParse(input) : null
  if (patch && !patch.success) return { error: patch.error.issues[0]?.message ?? i18nText('Errors.issueMetadataInvalid') }
  const requestedWorkspace = z.object({ workspaceId: z.uuid().optional() }).safeParse(input)
  if (!requestedWorkspace.success) return { error: i18nText('Errors.projectCheckFields') }
  const context = await projectContext(requestedWorkspace.data.workspaceId)
  const reference = patch?.success
    ? (await accessibleProjectReferences(context.user, context.workspaceId)).find(item => item.id === patch.data.id)
    : undefined
  if (patch?.success && !reference) return { error: i18nText('Errors.projectNotFound') }
  const write = () => withTaskWorkspace(context.user, context.workspaceId, async (_workspace, tx) => {
      const current = patch?.success ? await readProject(tx, context.user, context.workspaceId, patch.data.id) : undefined
      const merged = patch?.success ? { ...current, ...patch.data.changes, id: patch.data.id, revision: patch.data.revision } : input
      // Legacy patch fields and the explicit ID fields have the same authority.
      // A stale hydrated alias must not override the field the caller changed.
      if (patch?.success && merged && typeof merged === 'object') {
        if ('lead' in patch.data.changes && !('leadUserId' in patch.data.changes)) delete (merged as Record<string, unknown>).leadUserId
        if ('properties' in patch.data.changes && !('memberIds' in patch.data.changes)) delete (merged as Record<string, unknown>).memberIds
      }
      const parsed = projectInput.safeParse(merged)
      if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? i18nText('Errors.projectCheckFields') }
      const { id, revision, workspaceId: _workspaceId, leadUserId: _leadUserId, memberIds: _memberIds, ...values } = parsed.data
      if (parsed.data.workspaceId && parsed.data.workspaceId !== context.workspaceId) throw new ActionFailureError('workspaceAccessDenied')
      const people = projectPeople(parsed.data, context.user.id)
      await lockPeople(tx, context.workspaceId, people)
      await lockTeamRelations(tx)
      const existing = id ? await requireProjectWrite(tx, context.user, id, context.workspaceId) : null
      if (existing && existing.revision !== revision) return { error: i18nText('Errors.projectStale') }
      const graph = await accessibleProjects(context.user, tx, context.workspaceId)
      if (values.properties.dependencyIds.some(dependencyId => !graph.some(project => project.id === dependencyId))) return { error: i18nText('Errors.projectDependencyNotFound') }
      const nextId = id ?? crypto.randomUUID()
      if (hasDependencyCycle(nextId, values.properties.dependencyIds, graph)) return { error: i18nText('Errors.projectDependencyCycle') }
      // These old columns are harmless compatibility snapshots, never relation inputs.
      const stored = { ...values, lead: people.leadUserId ?? '', leadUserId: people.leadUserId, properties: { ...values.properties, members: people.memberIds } }
      // Match the established lock order: Workspace/member, relations, then the
      // APP content ACL. The already-held relation lock must not wait behind a
      // second path that takes the ACL first.
      const save = async () => {
        // Signal that the matching canonical member writes below are part of this
        // already-authorized transaction. The marker expires with this transaction.
        await tx.execute(sql`select set_config('mikka.project_v2_writer', '1', true)`)
        const [saved] = existing
          ? await tx.update(projects).set({ ...stored, revision: existing.revision + 1, updatedAt: new Date() })
            .where(and(eq(projects.id, nextId), eq(projects.workspaceId, context.workspaceId), eq(projects.revision, existing.revision))).returning()
          : await tx.insert(projects).values({ ...stored, id: nextId, workspaceId: context.workspaceId, userId: context.user.id, issueIds: [], revision: 1 }).returning()
        if (!saved) throw new ActionFailureError('projectSaveConflict')
        // A new Project becomes a content resource only after its canonical row
        // exists. The nested APP commit can leave an unreachable policy if this
        // Workspace transaction later fails, never an unguarded Project.
        if (!existing) await registerProjectAccess(context.user, nextId, context.workspaceId)
        await tx.delete(projectMembers).where(eq(projectMembers.projectId, nextId))
        for (let offset = 0; offset < people.memberIds.length; offset += batchSize) {
          await tx.insert(projectMembers).values(people.memberIds.slice(offset, offset + batchSize).map(userId => ({ projectId: nextId, workspaceId: context.workspaceId, userId })))
        }
        await emitProjectChange(tx, nextId, context.user.id, i18nText(existing ? 'Projects.activity.updatedOverview' : 'Projects.activity.created'))
        return { project: await readProject(tx, context.user, context.workspaceId, nextId) }
      }
      return reference ? withResourceAccess(context.user, reference, 'canSteer', save) : save()
    })
  try {
    return await write()
  } catch (error) {
    return { error: error instanceof ActionFailureError ? i18nText(`Errors.${error.code}`) : i18nText('Errors.projectSaveFailed') }
  }
}

export async function saveProject(input: z.input<typeof projectInput>) { return persistProject(input, false) }
export async function updateProjectProperties(input: { id: string; revision: number; changes: ProjectChanges; workspaceId?: string }) { return persistProject(input, true) }

export async function moveIssueToProject(input: { issueId: string; revision: number; projectId: string | null; workspaceId?: string; confirmAccess?: boolean }) {
  const i18nText = await getTranslations()
  const parsed = z.object({ issueId: z.uuid(), revision: z.number().int().positive(), projectId: z.uuid().nullable(), workspaceId: z.uuid().optional(), confirmAccess: z.boolean().optional() }).safeParse(input)
  if (!parsed.success) return { error: i18nText('Errors.projectMoveInvalid') }
  const context = await projectContext(parsed.data.workspaceId)
  try {
    const result = await withTaskWorkspace(context.user, context.workspaceId, async (_workspace, tx) => {
      await lockTeamRelations(tx)
      const [previous] = await tx.select().from(projectTasks).where(eq(projectTasks.issueId, parsed.data.issueId))
      if (previous && previous.workspaceId !== context.workspaceId) throw new ActionFailureError('issueNotFound')
      const projectIds = [...new Set([previous?.projectId, parsed.data.projectId].filter((id): id is string => Boolean(id)))].sort()
      const linked: (typeof projects.$inferSelect)[] = []
      for (const id of projectIds) linked.push(await requireProjectWrite(tx, context.user, id, context.workspaceId, { allowArchived: id !== parsed.data.projectId }))
      const references = await accessibleProjectReferences(context.user, context.workspaceId)
      const projectReferences = linked.map(project => references.find(reference => reference.id === project.id))
      if (projectReferences.some(reference => !reference)) throw new ActionFailureError('projectNotFound')
      const priorByProject = new Map<string, string[]>()
      for (const project of linked) {
        const rows = await tx.select({ id: projectTasks.issueId }).from(projectTasks).where(eq(projectTasks.projectId, project.id))
        priorByProject.set(project.id, rows.map(row => row.id).sort())
      }
      return db.transaction(async application => {
        await lockResourcesAccess(application, context.user.id, [
          ...projectReferences.map(reference => ({ reference: reference!, action: 'canSteer' as const })),
          { reference: { kind: 'task' as const, id: parsed.data.issueId, workspaceId: context.workspaceId }, action: 'canSteer' as const },
        ], true)
        const [task] = await application.select().from(issues).where(and(eq(issues.id, parsed.data.issueId), issueVisibilityPredicate(context.user.id, { allowedIds: [], workspaceIds: [context.workspaceId] }))).for('update')
        if (!task) throw new ActionFailureError('issueNotFound')
        if (task.revision !== parsed.data.revision) throw new ActionFailureError('issueOutdated')
        if ((previous?.projectId ?? null) === parsed.data.projectId) return task
        // Refuse before stopping runs or changing canonical Workspace relations.
        await assertAccessConfirmation(application, context.workspaceId, [{
          reference: { kind: 'task', id: task.id },
          parent: parsed.data.projectId ? { kind: 'project', id: parsed.data.projectId } : null,
        }], parsed.data.confirmAccess === true)
        const stopped = await application.execute<StoppedPolicyRun>(runPolicyStopSQL({ kind: 'task', issueId: task.id }))
        notifyStoppedPolicyRuns(application, stopped.rows)
        await tx.delete(projectTasks).where(eq(projectTasks.issueId, task.id))
        if (parsed.data.projectId) await tx.insert(projectTasks).values({ issueId: task.id, projectId: parsed.data.projectId, workspaceId: context.workspaceId })
        // Locks were acquired by ID; remove the old ACL parent before attaching
        // the new one so a destination sorting first cannot invalidate removal.
        for (const project of linked.toSorted((left, right) => Number(left.id === parsed.data.projectId) - Number(right.id === parsed.data.projectId))) {
          const before = priorByProject.get(project.id) ?? []
          const after = project.id === parsed.data.projectId
            ? [...before.filter(id => id !== task.id), task.id].sort()
            : before.filter(id => id !== task.id)
          await bindProjectTasks(application, context.user, { kind: 'project', id: project.id, workspaceId: context.workspaceId }, before, after, { confirmAccess: parsed.data.confirmAccess })
          await tx.update(projects).set({ revision: project.revision + 1, updatedAt: new Date() }).where(eq(projects.id, project.id))
          await emitProjectChange(tx, project.id, context.user.id, i18nText(project.id === parsed.data.projectId ? 'Projects.activity.tasksAdded' : 'Projects.activity.tasksRemoved'))
        }
        // The canonical relationship commits in the Workspace DB. APP keeps an
        // optimistic-concurrency/version event, without a second project-name store.
        const [saved] = await application.update(issues).set({ revision: task.revision + 1, updatedAt: new Date() }).where(and(eq(issues.id, task.id), eq(issues.revision, task.revision))).returning()
        if (!saved) throw new ActionFailureError('issueOutdated')
        await application.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: saved.id, userId: saved.userId, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, ...activityActor(context.user.id) })
        await issueListChanged(application, saved.id)
        return saved
      })
    })
    return { issue: await issueView(result) }
  } catch (error) {
    if (error instanceof ActionFailureError && error.confirmable) return { error: error.code, params: error.params, confirmable: error.confirmable }
    return { error: error instanceof ActionFailureError ? i18nText(`Errors.${error.code}`) : i18nText('Errors.projectMoveFailed') }
  }
}

export async function listProjectEvents(id: string, workspaceId?: string) {
  z.uuid().parse(id)
  const context = await projectContext(workspaceId)
  const reference = (await accessibleProjectReferences(context.user, context.workspaceId)).find(item => item.id === id)
  if (!reference) throw new ActionFailureError('projectNotFound')
  return withResourceAccess(context.user, reference, 'canReadContent', async () => {
    await readProject(projectDb, context.user, context.workspaceId, id)
    return projectDb.select().from(projectEvents).where(eq(projectEvents.projectId, id)).orderBy(desc(projectEvents.createdAt)).limit(100)
  })
}

export async function setProjectIssues(input: { id: string; revision: number; issueIds: string[]; workspaceId?: string; confirmAccess?: boolean }) {
  const i18nText = await getTranslations()
  const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), issueIds: z.array(z.uuid()), workspaceId: z.uuid().optional(), confirmAccess: z.boolean().optional() }).safeParse(input)
  if (!parsed.success) return { error: i18nText('Errors.projectIssuesInvalid') }
  const context = await projectContext(parsed.data.workspaceId)
  const reference = (await accessibleProjectReferences(context.user, context.workspaceId)).find(item => item.id === parsed.data.id)
  if (!reference) return { error: i18nText('Errors.projectNotFound') }
  const ids = [...new Set(parsed.data.issueIds)].sort()
  try {
    return await withTaskWorkspace(context.user, context.workspaceId, async (_workspace, tx) => {
      await lockTeamRelations(tx)
      const current = await requireProjectWrite(tx, context.user, parsed.data.id, context.workspaceId)
      if (current.revision !== parsed.data.revision) throw new ActionFailureError('projectSaveConflict')
      const prior = await tx.select({ id: projectTasks.issueId }).from(projectTasks).where(eq(projectTasks.projectId, current.id))
      const before = new Set(prior.map(row => row.id)), after = new Set(ids)
      const changed = [...new Set([...before, ...after])].filter(id => before.has(id) !== after.has(id))
      return withResourceAccess(context.user, reference, 'canSteer', () => db.transaction(async application => {
        for (let offset = 0; offset < ids.length; offset += batchSize) {
          const batch = ids.slice(offset, offset + batchSize)
          const found = await application.select({ id: issues.id }).from(issues)
            .where(and(inArray(issues.id, batch), issueVisibilityPredicate(context.user.id, { allowedIds: [], workspaceIds: [context.workspaceId] }))).orderBy(asc(issues.id)).for('share')
          if (found.length !== batch.length) throw new ActionFailureError('issueNotFound')
          const conflicts = await tx.select({ id: projectTasks.issueId }).from(projectTasks)
            .where(and(inArray(projectTasks.issueId, batch), ne(projectTasks.projectId, current.id))).limit(1)
          if (conflicts.length) throw new ActionFailureError('projectIssueAlreadyLinked')
        }
        await lockResourcesAccess(application, context.user.id, changed.map(id => ({
          reference: { kind: 'task' as const, id, workspaceId: context.workspaceId }, action: 'canSteer' as const,
        })))
        await assertAccessConfirmation(application, context.workspaceId, changed.map(id => ({
          reference: { kind: 'task' as const, id },
          parent: after.has(id) ? { kind: 'project', id: current.id } : null,
        })), parsed.data.confirmAccess === true)
        if (changed.length) {
          const stopped = await application.execute<StoppedPolicyRun>(runPolicyStopSQL({ kind: 'tasks', issueIds: changed }))
          notifyStoppedPolicyRuns(application, stopped.rows)
        }
        await bindProjectTasks(application, context.user, reference, [...before].sort(), ids, { confirmAccess: parsed.data.confirmAccess })
        await tx.delete(projectTasks).where(eq(projectTasks.projectId, current.id))
        for (let offset = 0; offset < ids.length; offset += batchSize) {
          await tx.insert(projectTasks).values(ids.slice(offset, offset + batchSize).map(issueId => ({ issueId, projectId: current.id, workspaceId: context.workspaceId })))
        }
        await tx.update(projects).set({ revision: current.revision + 1, updatedAt: new Date() }).where(eq(projects.id, current.id))
        await emitProjectChange(tx, current.id, context.user.id, i18nText('FeatureCopy.c_310e5541', { value0: ids.length }))
        for (const id of changed) await issueListChanged(application, id)
        return { project: await readProject(tx, context.user, context.workspaceId, current.id), error: undefined }
      }))
    })
  } catch (error) {
    if (error instanceof ActionFailureError && error.confirmable) return { error: error.code, params: error.params, confirmable: error.confirmable }
    return { error: error instanceof ActionFailureError ? i18nText(`Errors.${error.code}`) : i18nText('Errors.projectIssuesSaveFailed') }
  }
}

const lifecycleInput = z.object({ id: z.uuid(), workspaceId: z.uuid().optional(), revision: z.number().int().positive().optional() })

export async function getProjectLifecycleImpact(input: { id: string; workspaceId?: string }) {
  const parsed = lifecycleInput.parse(input)
  const context = await projectContext(parsed.workspaceId)
  return projectLifecycleImpact(context.user, context.workspaceId, parsed.id)
}

async function changeProjectArchive(input: { id: string; revision?: number; workspaceId?: string }, archived: boolean) {
  const parsed = lifecycleInput.parse(input)
  const context = await projectContext(parsed.workspaceId)
  const i18nText = await getTranslations()
  try {
    return { project: await setProjectArchive(context.user, context.workspaceId, { ...parsed, archived,
      message: i18nText(archived ? 'Projects.activity.archived' : 'Projects.activity.restored') }) }
  } catch (error) {
    if (error instanceof ActionFailureError) return { error: i18nText(`Errors.${error.code}`) }
    throw error
  }
}

export async function archiveProject(input: { id: string; revision?: number; workspaceId?: string }) { return changeProjectArchive(input, true) }
export async function restoreProject(input: { id: string; revision?: number; workspaceId?: string }) { return changeProjectArchive(input, false) }

export async function deleteProject(input: { id: string; revision: number; confirmation: string; workspaceId?: string }) {
  const parsed = lifecycleInput.extend({ revision: z.number().int().positive(), confirmation: z.string().trim().max(200) }).parse(input)
  const context = await projectContext(parsed.workspaceId)
  const i18nText = await getTranslations()
  try { return await deleteProjectData(context.user, context.workspaceId, parsed) }
  catch (error) {
    if (error instanceof ActionFailureError) return { error: i18nText(`Errors.${error.code}`) }
    throw error
  }
}
