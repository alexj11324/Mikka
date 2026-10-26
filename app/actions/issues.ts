'use server'

import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionErrorCode, ActionResult } from '@/lib/action-result'
import { currentUser } from '@/lib/acting-user'
import { accessibleTeams } from '@/lib/team-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { issueVisibility } from '@/lib/issue-visibility'
import { issueTeamScope } from '@/lib/issue-team-access'
import { db } from '@/lib/db'
import { issues, issueVersions, issueMembers, users } from '@/lib/db/schema'
import { requireIssueAccess } from '@/lib/issue-access'
import { issueChecklist } from '@/lib/issue-checklist'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'
import type { JSONContent } from '@tiptap/react'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueView, taskIdentifiers } from '@/lib/task-identifier-server'
import { ensureIssueNumbers } from '@/lib/issue-numbering'
import { createIssueForUserInTransaction } from '@/lib/issue-create'
import { createTeamIssueForUser } from '@/lib/team-issue-create'
import { dispatchLinearIssueSync } from '@/lib/linear-sync/dispatch'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { issueDoneEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { after } from 'next/server'
import { judgeIssueScope } from '@/lib/issue-scope-judge'
import { changeIssueScopeLocally, previewPersonalScope } from '@/lib/issue-scope-store'
import { TASK_SCOPES } from '@/lib/task-identifier'
import { enrichActivityActors } from '@/lib/activity-actor-server'
import { activityActor } from '@/lib/activity-actor'

type IssueRow = typeof issues.$inferSelect
type IssueView = IssueRow & { metadata: ReturnType<typeof readIssueMetadata>; identifier: string | null }

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

export async function listIssues() {
  const userId = await getUserId()
  const context = await loadWorkspaceContext()
  const teams = await accessibleTeams(userId, context.workspace.id)
  const visibility = await issueVisibility(userId)
  const rows = await db.select({ id: issues.id, ownerId: issues.userId, ownerName: users.name, ownerImage: users.image, title: issues.title, content: issues.content, status: issues.status, priority: issues.priority, scope: issues.scope, revision: issues.revision, createdAt: issues.createdAt, updatedAt: issues.updatedAt }).from(issues).leftJoin(users, eq(users.id, issues.userId)).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId))).where(and(visibility.predicate, sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')->>'deletedAt' is null`)).orderBy(desc(issues.updatedAt)).limit(100)
  const links = await issueTeamScope(userId, rows.map(row => row.id))
  const visibleRows = rows.filter(row => { const link = links.find(item => item.issueId === row.id); return row.scope === 'personal' || !link || teams.some(team => team.id === link.teamId) })
  const ownersWithoutNumbers = [...new Set(visibleRows.filter(row => !readIssueMetadata(row.content).number).map(row => row.ownerId))]
  if (ownersWithoutNumbers.length) {
    for (const ownerId of ownersWithoutNumbers) await ensureIssueNumbers(ownerId)
    return listIssues()
  }
  const liveRows = visibleRows.filter(row => !readIssueMetadata(row.content).deletedAt)
  const identifiers = await taskIdentifiers(liveRows.map(row => ({ id: row.id, ownerId: row.ownerId, scope: row.scope, number: readIssueMetadata(row.content).number })))
  return liveRows.map(({ content, ...issue }) => ({ ...issue, identifier: identifiers.get(issue.id) ?? null, teamId: links.find(link => link.issueId === issue.id)?.teamId ?? null, metadata: readIssueMetadata(content), checklist: issueChecklist(content) }))
}

export async function getIssue(id: string) {
  let { issue } = await requireIssueAccess(id)
  if (!readIssueMetadata(issue.content).number) {
    await ensureIssueNumbers(issue.userId)
    issue = (await requireIssueAccess(id)).issue
  }
  return issueView(issue)
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
    const ownerId = id ? (await requireIssueAccess(id)).issue.userId : userId
    if (input.id && (!Number.isInteger(input.revision) || (input.revision ?? 0) < 1)) return { error: 'issueRevisionInvalid' }
    let doneEvent = false
    try {
      const result = await db.transaction(async tx => {
        if (!id) {
          const issue = await createIssueForUserInTransaction(tx, userId, parsed.data, activityActor(userId))
          return issue ? { issue } : { error: 'issueCreateFailed' }
        }
        let issue
        const [latest] = await tx.select().from(issues).where(and(eq(issues.id, id), eq(issues.userId, ownerId))).for('update')
        if (!latest) return { error: 'issueNotFound' }
        ;[issue] = await tx.update(issues).set({ ...parsed.data, content: latest.content, revision: input.revision! + 1, updatedAt: new Date() }).where(and(eq(issues.id, id), eq(issues.userId, ownerId), eq(issues.revision, input.revision!))).returning()
        const done = issue && issueDoneEvent(latest, issue)
        if (done) {
          await recordCoordinatorEvent(tx, done)
          doneEvent = true
        }
        if (!issue) return { error: 'issueStale' }
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: id, userId: ownerId, revision: issue.revision, title: issue.title, content: issue.content, status: issue.status, priority: issue.priority, ...activityActor(userId) })
        return { issue: await issueView(issue, tx) }
      })
      if ('issue' in result && result.issue) dispatchLinearIssueSync(result.issue.id)
      if (!id && 'issue' in result && result.issue) { const created = result.issue.id; after(() => judgeIssueScope(created, 'the Mikka app')) }
      if (doneEvent && 'issue' in result) after(() => wakeCoordinator(ownerId))
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
  const userId = await getUserId()
  if (activityActor(userId).actorType !== 'user') return { error: 'teamIssueAccessDenied' as const }
  return createTeamIssueForUser(userId, input)
}

export async function moveIssue(input: { id: string; status: string; revision: number }): Promise<ActionResult<{ issue: IssueView }>> {
  return runAction(async () => {
    const parsed = z.object({ id: z.uuid(), status: inputSchema.shape.status, revision: z.number().int().positive() }).safeParse(input)
    if (!parsed.success) return { error: 'issueMoveInvalid' }
    const issue = await getIssue(parsed.data.id)
    if (issue.revision !== parsed.data.revision) return { error: 'issueStale' }
    if (issue.status === parsed.data.status) return { issue }
    return saveIssue({ ...issue, status: parsed.data.status })
  })
}

export async function changeIssuePriority(input: { id: string; priority: string; revision: number }): Promise<ActionResult<{ issue: IssueView }>> {
  return runAction(async () => {
    const parsed = z.object({ id: z.uuid(), priority: inputSchema.shape.priority, revision: z.number().int().positive() }).safeParse(input)
    if (!parsed.success) return { error: 'issuePriorityInvalid' }
    const issue = await getIssue(parsed.data.id)
    if (issue.revision !== parsed.data.revision) return { error: 'issueStale' }
    if (issue.priority === parsed.data.priority) return { issue }
    return saveIssue({ ...issue, priority: parsed.data.priority })
  })
}

/** Preview is owner-only and does not make a provider request. A positive
 * externalCopyPossible means an old remote copy may still be team-visible. */
export async function previewIssuePersonalScope(id: string) {
  const userId = await getUserId()
  if (!z.uuid().safeParse(id).success) return { error: 'issueScopeInvalid' as const }
  return previewPersonalScope(userId, id)
}

/** The linked case remains closed until the archive/unlink policy is chosen. */
export async function confirmIssuePersonalScope(input: { id: string; revision: number; confirmation: string }) {
  const userId = await getUserId()
  const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), confirmation: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(input)
  if (!parsed.success) return { error: 'issueScopeInvalid' as const }
  return changeIssueScopeLocally(userId, { id: parsed.data.id, revision: parsed.data.revision, scope: 'personal' }, { allowLinkedPersonal: false, confirmation: parsed.data.confirmation })
}

export async function listIssueVersions(id: string) {
  const { issue } = await requireIssueAccess(id)
  const userId = issue.userId
  const versions = await db.select().from(issueVersions).where(and(eq(issueVersions.issueId, id), eq(issueVersions.userId, userId))).orderBy(desc(issueVersions.revision)).limit(50)
  return enrichActivityActors(versions, userId)
}

/**
 * The one-click scope change (MIK-47). The person's choice wins over the
 * agent's and becomes an example for its next judgment. Linked transitions
 * await the archive/unlink decision in #184.
 */
export async function setIssueScope(input: { id: string; revision: number; scope: string }): Promise<ActionResult<{ issue: IssueView }>> {
  return runAction(async () => {
    const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), scope: z.enum(TASK_SCOPES) }).safeParse(input)
    if (!parsed.success) return { error: 'issueScopeInvalid' }
    const userId = await getUserId()
    const { issue } = await requireIssueAccess(parsed.data.id)
    if (issue.userId !== userId) return { error: 'issueScopeOwnerOnly' }
    // #184 leaves archive vs unlink open. Keep linked transitions closed until
    // the provider disposition is confirmed and reviewed.
    const result = await changeIssueScopeLocally(userId, parsed.data, { allowLinkedPersonal: false })
    if ('issue' in result && parsed.data.scope === 'workspace') dispatchLinearIssueSync(issue.id)
    return result
  })
}
