'use server'

import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { nextTaskListCursor, taskListPageInput, TASK_LIST_PAGE_SIZE, type TaskListPageInput } from '@/lib/task-list-page'
import { singleFlight } from '@/lib/single-flight'

import { withDatabaseOperation } from '@/lib/db/egress-sample'
import { createHash } from 'node:crypto'
import { and, desc, eq, getTableColumns, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionErrorCode, ActionResult } from '@/lib/action-result'
import { currentUser } from '@/lib/acting-user'
import { accessibleTeamScopes } from '@/lib/team-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { issueVisibilityPredicate } from '@/lib/issue-visibility-policy'
import { issueTeamScope } from '@/lib/issue-team-access'
import { db } from '@/lib/db'
import { agents, issues, issueVersions, issueMembers, users } from '@/lib/db/schema'
import { requireIssueAccess, requireIssueAccessWithoutBody, requireUser } from '@/lib/issue-access'
import { checklistView, issueAttrsContent, issueChecklistChecked, issueChecklistTotal } from '@/lib/issue-summary-columns'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'
import type { JSONContent } from '@tiptap/react'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueView, taskAssignees, taskIdentifiers } from '@/lib/task-identifier-server'
import { projectViewsForTasks } from '@/lib/project-access'
import { projectDb, projects, projectTasks } from '@/lib/db/projects'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { createIssueForUserInTransaction } from '@/lib/issue-create'
import { issueShortTitle } from '@/lib/short-title-sql'
import { createTeamIssueForUser } from '@/lib/team-issue-create'
import { promoteExistingIssueForUser } from '@/lib/team-issue-promotion'
import { scheduleIssueEffect } from '@/lib/issue-effects'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { coordinatorBot } from '@/lib/coordinator/coordinator-bot'
import { issueStatusEvent } from '@/lib/coordinator-events'
import { changeIssueScopeLocally, previewPersonalScope } from '@/lib/issue-scope-store'
import { TASK_SCOPES } from '@/lib/task-identifier'
import { enrichActivityActors } from '@/lib/activity-actor-server'
import { actingContext, activityActor } from '@/lib/activity-actor'
import { requireCurrentIssueWorkspace, requireLockedIssueScope, withIssueWorkspace } from '@/lib/issue-scope-authorization'
import { queryVersion, queryVersions } from '@/lib/db/query-version'
import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues } from '@/lib/db/team-schema'
import { issueListChanged } from '@/lib/live/lists'
import { issueRelationsChanged } from '@/lib/live/issue-detail'
import { ownerListRead } from '@/lib/live/list-read-server'
import { beginOwnerListRead } from '@/lib/live/revision-read'
import { changedListIds, listPositionKey, readListPositions, unchangedList, type ListPosition } from '@/lib/list-poll'
import { cacheReadAction } from '@/lib/cache-read-action'
import { requireTaskWorkspace, taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'

type IssueRow = typeof issues.$inferSelect
export type IssueView = Awaited<ReturnType<typeof issueView<IssueRow>>>

async function getUserId() {
  const user = await currentUser()
  if (!user) throw new ActionFailureError('authRequired')
  return user.id
}

const documentSchema = z.custom<JSONContent>(value => {
  if (!value || typeof value !== 'object' || (value as JSONContent).type !== 'doc') return false
  return JSON.stringify(value).length <= 250000
})

const inputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: documentSchema,
  status: z.enum(ISSUE_STATUS_CODES),
  priority: z.enum(ISSUE_PRIORITY_CODES),
})

function validationCode(error: z.ZodError): ActionErrorCode {
  const field = error.issues[0]?.path[0]
  if (field === 'title') return 'validationTitleRequired'
  if (field === 'content') return 'validationDocument'
  return 'validationGeneric'
}

// SWR passes its cache key as an argument. Keep this public fetcher zero-argument.
export async function listIssues() {
  return (await readIssues()).items!
}

/** Auth and visibility are checked on every poll, including unchanged results. */
export async function pollIssues(known?: string, positions?: readonly ListPosition[]) {
  const previous = readListPositions(positions, 100)
  const valid = positions === undefined || previous !== undefined
  return readIssues(undefined, valid && known && /^[0-9a-f]{32}$/.test(known) ? known : undefined, previous)
}

/** The browser receives access failures as explicit codes, not a redacted
 * Server Action exception, so persisted data is cleared on its next sync. */
export async function syncIssueList(known?: string, positions?: readonly ListPosition[]) {
  return cacheReadAction(async () => ({ snapshot: await pollIssues(known, positions) }))
}

/** Explicit API workspace selection, with the same acting-user/membership checks. */
export async function listWorkspaceIssues(workspaceId: string) {
  z.uuid().parse(workspaceId)
  return (await readIssues(workspaceId)).items!
}

async function readIssues(workspaceId?: string, known?: string, previous?: ListPosition[]) {
  return withDatabaseOperation('/actions/issues/poll', () => readIssueSnapshot(workspaceId, known, previous))
}

export async function listWorkspaceTaskPage(input: TaskListPageInput) {
  const { workspaceId, after, dispatchedBy } = taskListPageInput.parse(input)
  if (await effectiveRequestWorkspace(await requireUser()) !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  try {
    const snapshot = await withDatabaseOperation('/actions/issues/page', () => readIssueSnapshot(workspaceId, undefined, undefined, after, dispatchedBy))
    const items = snapshot.items ?? []
    return { workspaceId, items, next: nextTaskListCursor(items), reset: false }
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'issueStale') return { workspaceId, items: [], next: null, reset: true }
    throw error
  }
}

async function readIssueSnapshot(workspaceId?: string, known?: string, previous?: ListPosition[], after?: TaskListPageInput['after'], dispatchedBy?: string) {
  const userId = await getUserId()
  const context = await loadWorkspaceContext(workspaceId)
  // Before the list: the selected workspace's key and the home's key, both of which this list listens to.
  const begun = await beginOwnerListRead(userId, ['issue_list'], [{ kind: 'issue_list', id: context.workspace.id }])
  const live = { ...await ownerListRead(userId, [], Date.now(), begun), selectedWorkspaceId: context.workspace.id }
  // Membership is fresh for each poll. Reuse only this operation's narrow
  // identity rows for visibility, workspace filtering and remaining links.
  const allTeams = await accessibleTeamScopes(userId)
  const teams = allTeams.filter(team => team.workspaceId === context.workspace.id)
  // Fingerprint before reading links that will be reused below. A relation
  // moved during this read must invalidate the next poll, never be acknowledged
  // with a newer fingerprint while returning its older team.
  const linksQuery = workspaceDb.select({ issueId: teamIssues.issueId, teamId: teamIssues.teamId, workspaceId: teamIssues.workspaceId }).from(teamIssues)
    .where(and(eq(teamIssues.workspaceId, context.workspace.id), or(eq(teamIssues.userId, userId), teams.length ? inArray(teamIssues.teamId, teams.map(team => team.id)) : undefined)))
  // A departed/suspended human must disappear from responsibility even when
  // the Task's historical metadata did not change. These hashes are taken
  // before projection, so a concurrent revoke remains visible on the next read.
  const membersQuery = workspaceDb.select({ userId: workspaceMembers.userId, status: workspaceMembers.status }).from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, context.workspace.id))
  const projectsQuery = projectDb.select({ issueId: projectTasks.issueId, projectId: projects.id, name: projects.name }).from(projectTasks)
    .innerJoin(projects, and(eq(projects.id, projectTasks.projectId), eq(projects.workspaceId, projectTasks.workspaceId)))
    .where(eq(projectTasks.workspaceId, context.workspace.id))
  // These three authorities live in the canonical Workspace database. Read
  // their hashes together before reading any projection, without an APP join.
  const { linksVersion, membersVersion, projectsVersion } = await queryVersions({ linksVersion: linksQuery, membersVersion: membersQuery, projectsVersion: projectsQuery }, workspaceDb)
  // This operation already authorized the selected tenant in loadWorkspaceContext.
  // Keep that fresh membership result instead of loading it a second time.
  const visibility = {
    predicate: issueVisibilityPredicate(userId, { allowedIds: [], workspaceIds: [context.workspace.id] }),
    links: await issueTeamScope(userId, [], { teams, withTaskNumbers: true }),
  }
  // The predicate binds every candidate to this one authorized Workspace.
  // Restore that known ID in the DTO instead of transferring it per row.
  // Membership survives a later Run by a different Bot. Ask only about
  // the reader's own authorized dispatch history in this exact workspace.
  const dispatched = dispatchedBy ? sql`exists (select 1 from agent_runs r join bots b on b.id=r."botId"
    and b."ownerId"=${userId} and b."workspaceId"=${context.workspace.id}
    where r."userId"=${userId} and r."workspaceId"=${context.workspace.id} and r."issueId"=${issues.id} and r.source is distinct from 'mcp' and b.id=${dispatchedBy})` : undefined
  let continuation
  if (after) {
    // JavaScript timestamps carry milliseconds; PostgreSQL orders the exact
    // microsecond and UUID. Re-read the visible anchor before continuing.
    const [anchor] = await db.select({ time: sql<string>`${issues.updatedAt}::text` }).from(issues)
      .leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
      .where(and(visibility.predicate, dispatched, eq(issues.id, after.id), eq(issues.workspaceId, context.workspace.id),
        sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')->>'deletedAt' is null`)).limit(1)
    if (!anchor || new Date(anchor.time).getTime() !== Date.parse(after.updatedAt)) throw new ActionFailureError('issueStale')
    continuation = sql`(${issues.updatedAt}, ${issues.id}) < (${anchor.time}::timestamptz, ${after.id}::uuid)`
  }
  const candidates = db.select({ id: issues.id, ownerId: issues.userId, issuedIdentifier: issues.issuedIdentifier, ownerName: users.name, ownerImage: users.image, title: issues.title, shortTitle: issueShortTitle.as('shortTitle'), content: issueAttrsContent.as('content'), checklistTotal: issueChecklistTotal.as('checklistTotal'), checklistChecked: issueChecklistChecked.as('checklistChecked'), status: issues.status, priority: issues.priority, scope: issues.scope, revision: issues.revision, createdAt: issues.createdAt, updatedAt: issues.updatedAt }).from(issues).leftJoin(users, eq(users.id, issues.userId)).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId))).where(and(visibility.predicate, dispatched, continuation, sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')->>'deletedAt' is null`)).orderBy(desc(issues.updatedAt), desc(issues.id)).limit(TASK_LIST_PAGE_SIZE).as('task_list')
  // Issued identifiers are part of the Task row and do not follow Team,
  // personal-prefix or provider renames. Current human profile changes still
  // invalidate responsibility without rewriting historical Task metadata.
  const signature = db.select({ id: candidates.id, scope: candidates.scope, updatedAt: candidates.updatedAt, item: sql`to_jsonb(task_list)`.as('item'), identifiers: sql`jsonb_build_array(
    (select jsonb_build_array(person.name,person.image) from "user" person where person.id = coalesce(task_list.content->'attrs'->'mikka',task_list.content->'attrs'->'orvilo')->'assignee'->>'id')
  )`.as('identifiers') }).from(candidates)
  const tasksVersion = await queryVersion(signature)
  const version = createHash('sha256').update(JSON.stringify([userId, context.workspace.id, teams.map(team => team.id).sort(), tasksVersion, linksVersion, membersVersion, projectsVersion])).digest('hex').slice(0, 32)
  if (known === version) return { ...unchangedList(version), live }
  // Read the version first: a concurrent change is picked up on the next poll, never acknowledged unseen.
  const signed = signature.as('task_signatures')
  const manifest = await db.select({ id: signed.id, scope: signed.scope, signature: sql<string>`md5(to_jsonb(task_signatures)::text)` })
    .from(signed).orderBy(desc(signed.updatedAt), desc(signed.id))
  const knownLinks = new Map(visibility.links.map(link => [link.issueId, link]))
  const missingIds = manifest.filter(row => !knownLinks.has(row.id)).map(row => row.id)
  const missingTaskNumbers = manifest.some(row => row.scope === 'workspace' && !knownLinks.has(row.id))
  // Visibility already read every accessible team's links. Only owned or
  // unlinked candidates can still need a lookup (including a revoked team).
  const links = [
    ...manifest.flatMap(row => { const link = knownLinks.get(row.id); return link ? [link] : [] }),
    ...await issueTeamScope(userId, missingIds, { onlyIssueIds: missingIds, teams: allTeams, withTaskNumbers: missingTaskNumbers }),
  ]
  const taskTeams = new Map(links.flatMap(link => typeof link.key === 'string' && typeof link.number === 'number'
    ? [[link.issueId, { key: link.key, number: link.number }] as const] : []))
  // A timestamp alone misses deletions, membership changes, identifiers and
  // link moves. Rebuild the small authorized id manifest and read only rows
  // whose visible projection differs from the caller's held snapshot.
  const positions = manifest
    .map(row => ({ id: row.id, version: createHash('sha256').update(JSON.stringify([userId, context.workspace.id, row.signature, membersVersion, projectsVersion, links.find(link => link.issueId === row.id)?.teamId ?? null])).digest('hex').slice(0, 32) }))
  // Every request rebuilds visibility and the complete manifest before it may
  // join. A removed task/link therefore cannot inherit an older flight even
  // when this person's workspace role and team membership are unchanged.
  // A workspace token also has a narrower predicate than a browser session.
  return singleFlight(['/actions/issues/poll', userId, context.workspace.id, context.role,
    actingContext.getStore()?.tokenWorkspaceId ?? null, allTeams.map(team => `${team.id}:${team.workspaceId}`).sort().join(','),
    version, known ?? null, listPositionKey(previous), JSON.stringify(positions)], async () => {
    const changedIds = changedListIds(positions, previous)
    const rows = changedIds.length ? await db.select().from(candidates).where(inArray(candidates.id, changedIds)).orderBy(desc(candidates.updatedAt), desc(candidates.id)) : []
    const liveRows = rows.filter(row => !readIssueMetadata(row.content).deletedAt).map(row => ({ ...row, workspaceId: context.workspace.id }))
    // Reuse this request's authorized APP rows; only an unissued historical
    // Task needs the legacy reconciliation path and its additional queries.
    const identifiers = new Map(liveRows.filter(row => row.issuedIdentifier).map(row => [row.id, row.issuedIdentifier]))
    const unissued = liveRows.filter(row => !row.issuedIdentifier)
    for (const [id, identifier] of await taskIdentifiers(unissued.map(row => ({ id: row.id, ownerId: row.ownerId, scope: row.scope, number: readIssueMetadata(row.content).number })), db, taskTeams)) identifiers.set(id, identifier)
    const assignees = await taskAssignees(liveRows.map(row => ({ id: row.id, workspaceId: row.workspaceId, assignee: readIssueMetadata(row.content).assignee })))
    const taskProjects = await projectViewsForTasks(liveRows)
    // The leader's revision was read before these rows. Never stamp a joined
    // response with the joining request's possibly newer live revision.
    // The body stays in Postgres; only metadata and checklist counts are read.
    return { version, live, positions, ...(previous ? { delta: true as const } : {}), items: liveRows.map(({ content, checklistTotal, checklistChecked, ...issue }) => ({
      ...issue, issuedIdentifier: identifiers.get(issue.id) ?? null, identifier: identifiers.get(issue.id) ?? null,
      projectId: taskProjects.get(issue.id)?.projectId ?? null, teamId: links.find(link => link.issueId === issue.id)?.teamId ?? null,
      // Keep the legacy DTO union during the client rollout. taskAssignees
      // above is the runtime authority and emits only active members or null.
      metadata: { ...readIssueMetadata(content), assignee: assignees.get(issue.id) ?? null, project: taskProjects.get(issue.id)?.project ?? null } as ReturnType<typeof readIssueMetadata>,
      checklist: checklistView(checklistTotal, checklistChecked),
    })) }
  })
}

/** A missing, deleted or inaccessible task is an expected answer, not a server error. */
export async function getIssue(id: string): Promise<ActionResult<{ issue: IssueView }>> {
  return runAction(async () => ({ issue: await readIssue(id) }))
}

const { content: _issueBody, ...issueSummaryColumns } = getTableColumns(issues)

/** A cached detail still checks its current ACL. Its body hash is computed in
 * Postgres so a warm read returns no document unless the visible view changed. */
export async function pollIssue(id: string, known?: string): Promise<ActionResult<{ viewerId: string; version: string; issue: IssueView; unchanged?: never } | { viewerId: string; version: string; unchanged: true; issue?: never }>> {
  return cacheReadAction(() => withDatabaseOperation('/actions/issues/detail', async () => {
    const { issue, user } = await requireIssueAccessWithoutBody(id)
    if (!issue.issuedIdentifier) await taskIdentifiers([{ id: issue.id, ownerId: issue.userId, scope: issue.scope }])
    return db.transaction(async tx => {
      const [locked] = await tx.select({ ...issueSummaryColumns, content: issueAttrsContent, bodyVersion: sql<string>`md5(${issues.content}::text)` }).from(issues).where(eq(issues.id, id)).for('share')
      requireLockedIssueScope(locked, user.id, issue.scopeVersion, issue.workspaceId)
      await requireCurrentIssueWorkspace(user, issue.workspaceId, issue.id)
      // Same unavailable task as the entry ACL, when deletion committed before
      // this lock. A cursor never turns a deleted task into an unchanged result.
      if (readIssueMetadata(locked.content).deletedAt) throw new ActionFailureError('issueNotFound')
      const summary = await issueView(locked, tx)
      const version = createHash('sha256').update(JSON.stringify([user.id, summary])).digest('hex').slice(0, 32)
      if (known === version) return { viewerId: user.id, version, unchanged: true as const }
      const [body] = await tx.select({ content: issues.content }).from(issues).where(eq(issues.id, id))
      const { bodyVersion: _bodyVersion, ...view } = summary
      return { viewerId: user.id, version, issue: { ...view, content: body.content } }
    })
  }))
}

async function readIssue(id: string) {
  const { issue, user } = await requireIssueAccessWithoutBody(id)
  if (!issue.issuedIdentifier) await taskIdentifiers([{ id: issue.id, ownerId: issue.userId, scope: issue.scope }])
  return db.transaction(async tx => {
    const [locked] = await tx.select().from(issues).where(eq(issues.id, id)).for('share')
    requireLockedIssueScope(locked, user.id, issue.scopeVersion, issue.workspaceId)
    await requireCurrentIssueWorkspace(user, issue.workspaceId, issue.id)
    if (readIssueMetadata(locked.content).deletedAt) throw new ActionFailureError('issueNotFound')
    return issueView(locked, tx)
  })
}

export async function saveIssue(input: { id?: string; revision?: number; workspaceId?: string; title: string; content: JSONContent; status: string; priority: string }): Promise<ActionResult<{ issue: IssueView }>> {
  return runAction(async () => {
    const user = await requireUser()
    const userId = user.id
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) return { error: validationCode(parsed.error) }
    let id: string | undefined
    if (input.id) {
      const parsedId = z.uuid().safeParse(input.id)
      if (!parsedId.success) return { error: 'issueNotFound' }
      id = parsedId.data
    }
    const existing = id ? (await requireIssueAccess(id)).issue : null
    const pinnedWorkspaceId = taskReaderScope(user).workspaceId
    const context = pinnedWorkspaceId
      ? { workspace: await requireTaskWorkspace(user, input.workspaceId ?? pinnedWorkspaceId) }
      : await loadWorkspaceContext(input.workspaceId, user)
    if (existing && existing.workspaceId !== context.workspace.id) throw new ActionFailureError('workspaceAccessDenied')
    const ownerId = existing?.userId ?? userId
    const observedScopeVersion = existing?.scopeVersion ?? null
    if (input.id && (!Number.isInteger(input.revision) || (input.revision ?? 0) < 1)) return { error: 'issueRevisionInvalid' }
    let statusEvent = false
    // Status events stay in the task's stored tenant, including shared tasks.
    const coordinator = existing && parsed.data.status !== undefined && existing.status !== parsed.data.status ? (await coordinatorBot(ownerId, context.workspace.id, { backfill: false })).botId : null
    try {
      const save = () => db.transaction(async tx => {
        if (!id) {
          const issue = await createIssueForUserInTransaction(tx, userId, parsed.data, activityActor(userId), { workspaceId: context.workspace.id })
          return issue ? { issue } : { error: 'issueCreateFailed' }
        }
        let issue
        const [latest] = await tx.select().from(issues).where(and(eq(issues.id, id), eq(issues.userId, ownerId))).for('update')
        if (!latest) return { error: 'issueNotFound' }
        requireLockedIssueScope(latest, userId, observedScopeVersion!, context.workspace.id)
        ;[issue] = await tx.update(issues).set({ ...parsed.data, content: latest.content, revision: input.revision! + 1, updatedAt: new Date() }).where(and(eq(issues.id, id), eq(issues.userId, ownerId), eq(issues.revision, input.revision!))).returning()
        const changed = issue && coordinator && issueStatusEvent(latest, issue, coordinator)
        if (changed) {
          await recordCoordinatorEvent(tx, changed)
          statusEvent = true
        }
        if (!issue) return { error: 'issueStale' }
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: id, userId: ownerId, revision: issue.revision, title: issue.title, content: issue.content, status: issue.status, priority: issue.priority, ...activityActor(userId) })
        await issueListChanged(tx, id, latest.title !== issue.title)
        // Title, status and priority show in every connected task's relations panel.
        await issueRelationsChanged(tx, [id])
        return { issue: await issueView(issue, tx) }
      })
      const result = existing ? await withIssueWorkspace(user, context.workspace.id, { issueId: existing.id, action: 'canSteer' }, save) : await withTaskWorkspace(user, context.workspace.id, save)
      if ('issue' in result && result.issue?.linearSyncPolicy === 'explicit' && !result.issue.linearSyncBlocked && result.issue.linearTargetVerified) scheduleIssueEffect({ kind: 'sync', issueId: result.issue.id })
      if (statusEvent && 'issue' in result) scheduleIssueEffect({ kind: 'wake', userId: ownerId })
      return result
    } catch (error) {
      if (error instanceof ActionFailureError) throw error
      console.error('Failed to save issue', error instanceof Error ? error.message : 'database error')
      return { error: 'issueSaveFailed' }
    }
  })
}

/** Explicit local team choice. Use a stable requestId on retries. No Linear
 * destination is inferred; the returned task is blocked from provider sync. */
export async function createIssueForTeam(input: { requestId: string; teamId: string; title: string; content: JSONContent; status: string; priority: string }) {
  return runAction(async () => {
    // An actAs context can represent an agent or a trusted internal caller;
    // neither is evidence of a signed-in human choosing this team.
    if (actingContext.getStore()) return { error: 'teamIssueAccessDenied' as const }
    const userId = await getUserId()
    return createTeamIssueForUser(userId, input)
  })
}

/** Attach an existing task to a team in the task's immutable workspace. */
export async function promoteIssueToTeam(input: { requestId: string; issueId: string; revision: number; teamId: string; expectedTeamId: string | null }) {
  return runAction(async () => {
    if (actingContext.getStore()) return { error: 'teamIssueAccessDenied' as const }
    return promoteExistingIssueForUser(await getUserId(), input)
  })
}

export async function moveIssue(input: { id: string; status: string; revision: number }): Promise<ActionResult<{ issue: IssueView }>> {
  return runAction(async () => {
    const parsed = z.object({ id: z.uuid(), status: inputSchema.shape.status, revision: z.number().int().positive() }).safeParse(input)
    if (!parsed.success) return { error: 'issueMoveInvalid' }
    const issue = await readIssue(parsed.data.id)
    if (issue.revision !== parsed.data.revision) return { error: 'issueStale' }
    if (issue.status === parsed.data.status) return { issue }
    return saveIssue({ ...issue, workspaceId: issue.workspaceId ?? undefined, status: parsed.data.status })
  })
}

export async function changeIssuePriority(input: { id: string; priority: string; revision: number }): Promise<ActionResult<{ issue: IssueView }>> {
  return runAction(async () => {
    const parsed = z.object({ id: z.uuid(), priority: inputSchema.shape.priority, revision: z.number().int().positive() }).safeParse(input)
    if (!parsed.success) return { error: 'issuePriorityInvalid' }
    const issue = await readIssue(parsed.data.id)
    if (issue.revision !== parsed.data.revision) return { error: 'issueStale' }
    if (issue.priority === parsed.data.priority) return { issue }
    return saveIssue({ ...issue, workspaceId: issue.workspaceId ?? undefined, priority: parsed.data.priority })
  })
}

/** Preview is owner-only and does not make a provider request. A positive
 * externalCopyPossible means an old remote copy may still be team-visible. */
export async function previewIssuePersonalScope(id: string) {
  return runAction(async () => {
    const userId = await getUserId()
    if (!z.uuid().safeParse(id).success) return { error: 'issueScopeInvalid' as const }
    await requireIssueAccess(id)
    return previewPersonalScope(userId, id)
  })
}

/** The owner's confirmation retires the active link and queues its archive. */
export async function confirmIssuePersonalScope(input: { id: string; revision: number; confirmation: string }) {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), confirmation: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(input)
    if (!parsed.success) return { error: 'issueScopeInvalid' as const }
    await requireIssueAccess(parsed.data.id)
    const result = await changeIssueScopeLocally(userId, { id: parsed.data.id, revision: parsed.data.revision, scope: 'personal' }, { allowLinkedPersonal: true, confirmation: parsed.data.confirmation })
    if ('issue' in result && result.issue) scheduleIssueEffect({ kind: 'sync', issueId: result.issue.id })
    return result
  })
}

export async function listIssueVersions(id: string) {
  const { issue, user } = await requireIssueAccessWithoutBody(id)
  const userId = issue.userId
  const versions = await db.transaction(async tx => {
    const [locked] = await tx.select({ userId: issues.userId, scope: issues.scope, workspaceId: issues.workspaceId, scopeVersion: issues.scopeVersion }).from(issues).where(eq(issues.id, id)).for('share')
    requireLockedIssueScope(locked, user.id, issue.scopeVersion, issue.workspaceId)
    await requireCurrentIssueWorkspace(user, issue.workspaceId, issue.id)
    return tx.select().from(issueVersions).where(and(eq(issueVersions.issueId, id), eq(issueVersions.userId, userId))).orderBy(desc(issueVersions.revision)).limit(50)
  })
  return enrichActivityActors(versions, userId)
}

const { content: _versionBody, ...versionSummaryColumns } = getTableColumns(issueVersions)

/** Activity reads metadata only. Complete historical bodies are loaded by
 * listIssueVersions when the person opens the description-history dialog. */
export async function pollIssueVersionSummaries(id: string, known?: string, previous?: readonly ListPosition[]) {
  return cacheReadAction(() => withDatabaseOperation('/actions/issues/activity', async () => {
    const { issue, user } = await requireIssueAccessWithoutBody(id)
    const held = readListPositions(previous, 50)
    const result = await db.transaction(async tx => {
      const [locked] = await tx.select({ userId: issues.userId, scope: issues.scope, workspaceId: issues.workspaceId, scopeVersion: issues.scopeVersion, content: issueAttrsContent }).from(issues).where(eq(issues.id, id)).for('share')
      requireLockedIssueScope(locked, user.id, issue.scopeVersion, issue.workspaceId)
      await requireCurrentIssueWorkspace(user, issue.workspaceId, issue.id)
      // The same deleted-task refusal as pollIssue, after taking the shared lock.
      if (readIssueMetadata(locked.content).deletedAt) throw new ActionFailureError('issueNotFound')
      const summaries = tx.select({ ...versionSummaryColumns, content: sql<JSONContent>`jsonb_build_object('type', 'doc', 'attrs', ${issueVersions.content}->'attrs')`.as('content') })
        .from(issueVersions).where(and(eq(issueVersions.issueId, id), eq(issueVersions.userId, issue.userId))).orderBy(desc(issueVersions.revision), desc(issueVersions.id)).limit(50).as('activity_versions')
      const signatures = tx.select({ id: summaries.id, revision: summaries.revision, item: sql`to_jsonb(activity_versions)`.as('item'), actor: sql`jsonb_build_array(
        (select jsonb_build_array(${users.name}, ${users.image}) from ${users} where ${users.id}=${summaries.actorId} and ${summaries.actorType}='user'),
        (select ${agents.harness} from ${agents} where ${agents.id}::text=${summaries.actorId} and ${agents.userId}=${issue.userId} and ${summaries.actorType}='agent')
      )`.as('actor') }).from(summaries)
      const signature = await queryVersion(signatures, tx)
      const version = createHash('sha256').update(JSON.stringify([user.id, id, issue.scopeVersion, signature])).digest('hex').slice(0, 32)
      if ((previous === undefined || held !== undefined) && known === version) return { version, unchanged: true as const }
      const signed = signatures.as('activity_signatures')
      const positions = await tx.select({ id: signed.id, version: sql<string>`md5(to_jsonb(activity_signatures)::text)` }).from(signed).orderBy(desc(signed.revision), desc(signed.id))
      const ids = changedListIds(positions, held)
      const rows = ids.length ? await tx.select().from(summaries).where(inArray(summaries.id, ids)).orderBy(desc(summaries.revision), desc(summaries.id)) : []
      return { version, positions, rows, ...(held ? { delta: true as const } : {}) }
    })
    if (result.unchanged === true) return { viewerId: user.id, snapshot: result }
    const { rows, ...snapshot } = result
    return { viewerId: user.id, snapshot: { ...snapshot, items: await enrichActivityActors(rows, issue.userId) } }
  }))
}

/**
 * The one-click scope change (MIK-47). The person's choice wins over the
 * agent's and becomes an example for its next judgment. Linked transitions
 * retain the team's history through the existing archive outbox.
 */
export async function setIssueScope(input: { id: string; revision: number; scope: string }): Promise<ActionResult<{ issue: IssueView }>> {
  return runAction(async () => {
    const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), scope: z.enum(TASK_SCOPES) }).safeParse(input)
    if (!parsed.success) return { error: 'issueScopeInvalid' }
    const userId = await getUserId()
    const { issue } = await requireIssueAccess(parsed.data.id)
    if (issue.userId !== userId) return { error: 'issueScopeOwnerOnly' }
    // This legacy action has no team target or team permission check. It must
    // not infer the owner's active Linear team or publish an unassigned task.
    if (parsed.data.scope === 'workspace') return { error: 'issueScopeTeamRequired' }
    const result = await changeIssueScopeLocally(userId, parsed.data, { allowLinkedPersonal: true })
    if ('issue' in result && result.issue) scheduleIssueEffect({ kind: 'sync', issueId: result.issue.id })
    return result

  })
}
