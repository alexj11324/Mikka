'use server'

import { withDatabaseOperation } from '@/lib/db/egress-sample'
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionErrorCode, ActionResult } from '@/lib/action-result'
import { currentUser } from '@/lib/acting-user'
import { accessibleTeamScopes } from '@/lib/team-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { issueVisibility } from '@/lib/issue-visibility'
import { issueTeamScope } from '@/lib/issue-team-access'
import { db } from '@/lib/db'
import { issues, issueVersions, issueMembers, users } from '@/lib/db/schema'
import { requireIssueAccess } from '@/lib/issue-access'
import { checklistView, issueAttrsContent, issueChecklistChecked, issueChecklistTotal } from '@/lib/issue-summary-columns'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'
import type { JSONContent } from '@tiptap/react'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueView, taskIdentifiers } from '@/lib/task-identifier-server'
import { createIssueForUserInTransaction } from '@/lib/issue-create'
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
import { requireLockedIssueScope } from '@/lib/issue-scope-authorization'
import { queryVersion } from '@/lib/db/query-version'
import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues } from '@/lib/db/team-schema'
import { issueListChanged } from '@/lib/live/lists'
import { issueRelationsChanged } from '@/lib/live/issue-detail'
import { ownerListRead } from '@/lib/live/list-read-server'
import { issuePrefixes, linearIssueLinks, linearTeamSyncs } from '@/lib/db/schema'

type IssueRow = typeof issues.$inferSelect
export type IssueView = IssueRow & { metadata: ReturnType<typeof readIssueMetadata>; identifier: string | null; linearTargetVerified: boolean }

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
export async function pollIssues(known?: string) {
  return readIssues(undefined, known && /^[0-9a-f]{32}$/.test(known) ? known : undefined)
}

/** Explicit API workspace selection, with the same acting-user/membership checks. */
export async function listWorkspaceIssues(workspaceId: string) {
  z.uuid().parse(workspaceId)
  return (await readIssues(workspaceId)).items!
}

async function readIssues(workspaceId?: string, known?: string) {
  return withDatabaseOperation('/actions/issues/poll', () => readIssueSnapshot(workspaceId, known))
}

async function readIssueSnapshot(workspaceId?: string, known?: string) {
  const userId = await getUserId()
  const context = await loadWorkspaceContext(workspaceId)
  const live = { ...await ownerListRead(userId), selectedWorkspaceId: context.workspace.id }
  // Membership is fresh for each poll. Reuse only this operation's narrow
  // identity rows for visibility, workspace filtering and remaining links.
  const allTeams = await accessibleTeamScopes(userId)
  const teams = allTeams.filter(team => team.workspaceId === context.workspace.id)
  // Fingerprint before reading links that will be reused below. A relation
  // moved during this read must invalidate the next poll, never be acknowledged
  // with a newer fingerprint while returning its older team.
  const linksVersion = await queryVersion(workspaceDb.select({ issueId: teamIssues.issueId, teamId: teamIssues.teamId, workspaceId: teamIssues.workspaceId }).from(teamIssues)
    .where(or(eq(teamIssues.userId, userId), teams.length ? inArray(teamIssues.teamId, teams.map(team => team.id)) : undefined)), workspaceDb)
  const visibility = await issueVisibility(userId, false, undefined, db, { teams: allTeams })
  const candidates = db.select({ id: issues.id, ownerId: issues.userId, ownerName: users.name, ownerImage: users.image, title: issues.title, content: issueAttrsContent.as('content'), checklistTotal: issueChecklistTotal.as('checklistTotal'), checklistChecked: issueChecklistChecked.as('checklistChecked'), status: issues.status, priority: issues.priority, scope: issues.scope, revision: issues.revision, createdAt: issues.createdAt, updatedAt: issues.updatedAt }).from(issues).leftJoin(users, eq(users.id, issues.userId)).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId))).where(and(visibility.predicate, sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')->>'deletedAt' is null`)).orderBy(desc(issues.updatedAt), desc(issues.id)).limit(100).as('task_list')
  // Include identifier dependencies: a prefix, profile or Linear rename can change a list without editing a task.
  const signature = db.select({ item: sql`to_jsonb(task_list)`.as('item'), identifiers: sql`jsonb_build_array(
    (select ${users.email} from ${users} where ${users.id}=${candidates.ownerId}),
    (select ${issuePrefixes.prefix} from ${issuePrefixes} where ${issuePrefixes.userId}=${candidates.ownerId}),
    (select jsonb_agg(${linearTeamSyncs.linearTeamKey} order by ${linearTeamSyncs.linearTeamKey}) from ${linearTeamSyncs} where ${linearTeamSyncs.ownerId}=${candidates.ownerId}),
    (select jsonb_agg(${linearIssueLinks.linearIdentifier} order by ${linearIssueLinks.linearIdentifier}) from ${linearIssueLinks} where ${linearIssueLinks.issueId}=${candidates.id})
  )`.as('identifiers') }).from(candidates)
  const tasksVersion = await queryVersion(signature)
  const version = createHash('sha256').update(JSON.stringify([userId, context.workspace.id, teams.map(team => team.id).sort(), tasksVersion, linksVersion])).digest('hex').slice(0, 32)
  if (known === version) return { unchanged: true, version, live } as const
  // Read the version first: a concurrent change is picked up on the next poll, never acknowledged unseen.
  const rows = await db.select().from(candidates).orderBy(desc(candidates.updatedAt), desc(candidates.id))
  const knownLinks = new Map(visibility.links.map(link => [link.issueId, link]))
  const missingIds = rows.filter(row => !knownLinks.has(row.id)).map(row => row.id)
  // Visibility already read every accessible team's links. Only owned or
  // unlinked candidates can still need a lookup (including a revoked team).
  const links = [
    ...rows.flatMap(row => { const link = knownLinks.get(row.id); return link ? [link] : [] }),
    ...await issueTeamScope(userId, missingIds, { onlyIssueIds: missingIds, teams: allTeams }),
  ]
  const visibleRows = rows.filter(row => { const link = links.find(item => item.issueId === row.id); return row.scope === 'personal' || !link || teams.some(team => team.id === link.teamId) })
  const liveRows = visibleRows.filter(row => !readIssueMetadata(row.content).deletedAt)
  const identifiers = await taskIdentifiers(liveRows.map(row => ({ id: row.id, ownerId: row.ownerId, scope: row.scope, number: readIssueMetadata(row.content).number })))
  // The body stays in Postgres: only its attrs (metadata) and checklist counts are read, not up to 100 whole bodies per poll.
  return { version, live, items: liveRows.map(({ content, checklistTotal, checklistChecked, ...issue }) => ({ ...issue, identifier: identifiers.get(issue.id) ?? null, teamId: links.find(link => link.issueId === issue.id)?.teamId ?? null, metadata: readIssueMetadata(content), checklist: checklistView(checklistTotal, checklistChecked) })) }
}

/** A missing, deleted or inaccessible task is an expected answer, not a server error. */
export async function getIssue(id: string): Promise<ActionResult<{ issue: IssueView }>> {
  return runAction(async () => ({ issue: await readIssue(id) }))
}

async function readIssue(id: string) {
  const { issue, user } = await requireIssueAccess(id)
  return db.transaction(async tx => {
    const [locked] = await tx.select().from(issues).where(eq(issues.id, id)).for('share')
    requireLockedIssueScope(locked, user.id, issue.scopeVersion)
    return issueView(locked, tx)
  })
}

export async function saveIssue(input: { id?: string; revision?: number; title: string; content: JSONContent; status: string; priority: string }): Promise<ActionResult<{ issue: IssueView }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) return { error: validationCode(parsed.error) }
    let id: string | undefined
    if (input.id) {
      const parsedId = z.uuid().safeParse(input.id)
      if (!parsedId.success) return { error: 'issueNotFound' }
      id = parsedId.data
    }
    const existing = id ? (await requireIssueAccess(id)).issue : null
    const ownerId = existing?.userId ?? userId
    const observedScopeVersion = existing?.scopeVersion ?? null
    if (input.id && (!Number.isInteger(input.revision) || (input.revision ?? 0) < 1)) return { error: 'issueRevisionInvalid' }
    let statusEvent = false
    // A status change is recorded for its owner's Coordinator (triage decides whether it matters); its bot row is resolved
    // here, before the transaction. A task names no workspace, so it is the personal workspace's Coordinator.
    const coordinator = existing && parsed.data.status !== undefined && existing.status !== parsed.data.status ? (await coordinatorBot(ownerId, null, { backfill: false })).botId : null
    try {
      const result = await db.transaction(async tx => {
        if (!id) {
          const issue = await createIssueForUserInTransaction(tx, userId, parsed.data, activityActor(userId))
          return issue ? { issue } : { error: 'issueCreateFailed' }
        }
        let issue
        const [latest] = await tx.select().from(issues).where(and(eq(issues.id, id), eq(issues.userId, ownerId))).for('update')
        if (!latest) return { error: 'issueNotFound' }
        requireLockedIssueScope(latest, userId, observedScopeVersion!)
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
      if ('issue' in result && result.issue?.scope === 'workspace' && !result.issue.linearSyncBlocked && result.issue.linearTargetVerified) scheduleIssueEffect({ kind: 'sync', issueId: result.issue.id })
      if (!id && 'issue' in result && result.issue) scheduleIssueEffect({ kind: 'scope', issueId: result.issue.id })
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

/** Explicitly move an existing personal issue to a Mikka team. */
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
    return saveIssue({ ...issue, status: parsed.data.status })
  })
}

export async function changeIssuePriority(input: { id: string; priority: string; revision: number }): Promise<ActionResult<{ issue: IssueView }>> {
  return runAction(async () => {
    const parsed = z.object({ id: z.uuid(), priority: inputSchema.shape.priority, revision: z.number().int().positive() }).safeParse(input)
    if (!parsed.success) return { error: 'issuePriorityInvalid' }
    const issue = await readIssue(parsed.data.id)
    if (issue.revision !== parsed.data.revision) return { error: 'issueStale' }
    if (issue.priority === parsed.data.priority) return { issue }
    return saveIssue({ ...issue, priority: parsed.data.priority })
  })
}

/** Preview is owner-only and does not make a provider request. A positive
 * externalCopyPossible means an old remote copy may still be team-visible. */
export async function previewIssuePersonalScope(id: string) {
  return runAction(async () => {
    const userId = await getUserId()
    if (!z.uuid().safeParse(id).success) return { error: 'issueScopeInvalid' as const }
    return previewPersonalScope(userId, id)
  })
}

/** The owner's confirmation retires the active link and queues its archive. */
export async function confirmIssuePersonalScope(input: { id: string; revision: number; confirmation: string }) {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), confirmation: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(input)
    if (!parsed.success) return { error: 'issueScopeInvalid' as const }
    const result = await changeIssueScopeLocally(userId, { id: parsed.data.id, revision: parsed.data.revision, scope: 'personal' }, { allowLinkedPersonal: true, confirmation: parsed.data.confirmation })
    if ('issue' in result && result.issue) scheduleIssueEffect({ kind: 'sync', issueId: result.issue.id })
    return result
  })
}

export async function listIssueVersions(id: string) {
  const { issue, user } = await requireIssueAccess(id)
  const userId = issue.userId
  const versions = await db.transaction(async tx => {
    const [locked] = await tx.select().from(issues).where(eq(issues.id, id)).for('share')
    requireLockedIssueScope(locked, user.id, issue.scopeVersion)
    return tx.select().from(issueVersions).where(and(eq(issueVersions.issueId, id), eq(issueVersions.userId, userId))).orderBy(desc(issueVersions.revision)).limit(50)
  })
  return enrichActivityActors(versions, userId)
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
