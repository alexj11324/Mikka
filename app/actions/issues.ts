'use server'

import { headers } from 'next/headers'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionErrorCode, ActionResult } from '@/lib/action-result'
import { accessibleTeams } from '@/lib/team-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { issueTeamScope } from '@/lib/issue-team-access'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { issues, issueVersions, issueMembers, users } from '@/lib/db/schema'
import { requireIssueAccess } from '@/lib/issue-access'
import { issueChecklist } from '@/lib/issue-checklist'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'
import type { JSONContent } from '@tiptap/react'
import { issueWithMetadata, readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'
import { allocateIssueNumbers, ensureIssueNumbers } from '@/lib/issue-numbering'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { issueDoneEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { after } from 'next/server'

type IssueRow = typeof issues.$inferSelect
type IssueView = IssueRow & { metadata: ReturnType<typeof readIssueMetadata> }

async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
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
  const publicLinks = await issueTeamScope(userId)
  const publicIds = publicLinks.map(link => link.issueId)
  const rows = await db.select({ id: issues.id, ownerId: issues.userId, ownerName: users.name, ownerImage: users.image, title: issues.title, content: issues.content, status: issues.status, priority: issues.priority, revision: issues.revision, createdAt: issues.createdAt, updatedAt: issues.updatedAt }).from(issues).leftJoin(users, eq(users.id, issues.userId)).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId))).where(and(or(eq(issues.userId, userId), eq(issueMembers.memberId, userId), publicIds.length ? inArray(issues.id, publicIds) : undefined), sql`coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')->>'deletedAt' is null`)).orderBy(desc(issues.updatedAt)).limit(100)
  const links = await issueTeamScope(userId, rows.map(row => row.id))
  const visibleRows = rows.filter(row => { const link = links.find(item => item.issueId === row.id); return !link || teams.some(team => team.id === link.teamId) })
  const ownersWithoutNumbers = [...new Set(visibleRows.filter(row => !readIssueMetadata(row.content).number).map(row => row.ownerId))]
  if (ownersWithoutNumbers.length) {
    for (const ownerId of ownersWithoutNumbers) await ensureIssueNumbers(ownerId)
    return listIssues()
  }
  return visibleRows.filter(row => !readIssueMetadata(row.content).deletedAt).map(({ content, ...issue }) => ({ ...issue, teamId: links.find(link => link.issueId === issue.id)?.teamId ?? null, metadata: readIssueMetadata(content), checklist: issueChecklist(content) }))
}

export async function getIssue(id: string) {
  let { issue } = await requireIssueAccess(id)
  if (!readIssueMetadata(issue.content).number) {
    await ensureIssueNumbers(issue.userId)
    issue = (await requireIssueAccess(id)).issue
  }
  return issueWithMetadata(issue)
}

export async function saveIssue(input: { id?: string; revision?: number; title: string; content: JSONContent; status: string; priority: string }): Promise<ActionResult<{ issue: IssueView }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) return { error: validationCode(parsed.error) }
    let id: string
    if (input.id) {
      const parsedId = z.uuid().safeParse(input.id)
      if (!parsedId.success) return { error: 'issueNotFound' }
      id = parsedId.data
    } else {
      id = crypto.randomUUID()
    }
    const ownerId = input.id ? (await requireIssueAccess(id)).issue.userId : userId
    if (input.id && (!Number.isInteger(input.revision) || (input.revision ?? 0) < 1)) return { error: 'issueRevisionInvalid' }
    let doneEvent = false
    try {
      const result = await db.transaction(async tx => {
        let issue
        if (input.id) {
          const [latest] = await tx.select().from(issues).where(and(eq(issues.id, id), eq(issues.userId, ownerId))).for('update')
          if (!latest) return { error: 'issueNotFound' }
          ;[issue] = await tx.update(issues).set({ ...parsed.data, content: latest.content, revision: input.revision! + 1, updatedAt: new Date() }).where(and(eq(issues.id, id), eq(issues.userId, ownerId), eq(issues.revision, input.revision!))).returning()
          const done = issue && issueDoneEvent(latest, issue)
          if (done) {
            await recordCoordinatorEvent(tx, done)
            doneEvent = true
          }
        } else {
          const number = await allocateIssueNumbers(tx, userId)
          const metadata = { ...readIssueMetadata({ type: 'doc' }), number }
          ;[issue] = await tx.insert(issues).values({ ...parsed.data, content: withIssueMetadata(parsed.data.content, metadata), id, userId, revision: 1 }).returning()
        }
        if (!issue) return { error: 'issueStale' }
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: id, userId: ownerId, revision: issue.revision, title: issue.title, content: issue.content, status: issue.status, priority: issue.priority })
        return { issue: issueWithMetadata(issue) }
      })
      if (doneEvent && 'issue' in result) after(() => wakeCoordinator(ownerId))
      return result
    } catch (error) {
      if (error instanceof ActionFailureError) throw error
      console.error('Failed to save issue', error instanceof Error ? error.message : 'database error')
      return { error: 'issueSaveFailed' }
    }
  })
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

export async function listIssueVersions(id: string) {
  const { issue } = await requireIssueAccess(id)
  const userId = issue.userId
  return db.select().from(issueVersions).where(and(eq(issueVersions.issueId, id), eq(issueVersions.userId, userId))).orderBy(desc(issueVersions.revision)).limit(50)
}
