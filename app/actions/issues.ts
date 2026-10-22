'use server'
import { getTranslations } from 'next-intl/server'

import { headers } from 'next/headers'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { accessibleTeams } from '@/lib/team-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { issueTeamScope } from '@/lib/issue-team-access'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { issues, issueVersions, issueMembers, users } from '@/lib/db/schema'
import { requireIssueAccess } from '@/lib/issue-access'
import { issueChecklist } from '@/lib/issue-checklist'
import type { JSONContent } from '@tiptap/react'
import { issueWithMetadata, readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'
import { allocateIssueNumbers, ensureIssueNumbers } from '@/lib/issue-numbering'

async function getUserId() {
  const i18nText = await getTranslations();
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error(i18nText("Errors.authRequired"))
  return session.user.id
}
const documentSchema = z.custom<JSONContent>(value => {
  if (!value || typeof value !== 'object' || (value as JSONContent).type !== 'doc') return false
  return JSON.stringify(value).length <= 250000
}, 'validationDocument')
const inputSchema = z.object({
  title: z.string().trim().min(1, 'validationTitleRequired').max(200),
  content: documentSchema, status: z.enum(['backlog','todo','doing','review','done','canceled','duplicate']),
  priority: z.enum(['urgent','high','normal','low']),
})

export async function listIssues() {
  const userId = await getUserId()
  const context = await loadWorkspaceContext()
  const teams = await accessibleTeams(userId, context.workspace.id)
  const publicLinks = await issueTeamScope(userId)
  const publicIds = publicLinks.map(link => link.issueId)
  const rows = await db.select({ id: issues.id, ownerId: issues.userId, ownerName: users.name, ownerImage: users.image, title: issues.title, content: issues.content, status: issues.status, priority: issues.priority, revision: issues.revision, createdAt: issues.createdAt, updatedAt: issues.updatedAt }).from(issues).leftJoin(users, eq(users.id, issues.userId)).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId))).where(and(or(eq(issues.userId, userId), eq(issueMembers.memberId, userId), publicIds.length ? inArray(issues.id, publicIds) : undefined), sql`${issues.content}->'attrs'->'orvilo'->>'deletedAt' is null`)).orderBy(desc(issues.updatedAt)).limit(100)
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
export async function saveIssue(input: { id?: string; revision?: number; title: string; content: JSONContent; status: string; priority: string }) {
  const i18nText = await getTranslations();
  const userId = await getUserId()
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) {
    const code = parsed.error.issues[0]?.message
    const key = code === 'validationDocument' || code === 'validationTitleRequired' ? `Errors.${code}` : 'Errors.validationGeneric'
    return { error: i18nText(key as never) }
  }
  const id = input.id ? z.uuid().parse(input.id) : crypto.randomUUID()
  const ownerId = input.id ? (await requireIssueAccess(id)).issue.userId : userId
  if (input.id && (!Number.isInteger(input.revision) || (input.revision ?? 0) < 1)) return { error: i18nText("Errors.issueRevisionInvalid") }
  try {
    return await db.transaction(async tx => {
      let issue
      if (input.id) {
        const [latest] = await tx.select().from(issues).where(and(eq(issues.id, id), eq(issues.userId, ownerId))).for('update')
        if (!latest) return { error: i18nText("Errors.issueNotFound") }
        ;[issue] = await tx.update(issues).set({ ...parsed.data, content: latest.content, revision: input.revision! + 1, updatedAt: new Date() }).where(and(eq(issues.id, id), eq(issues.userId, ownerId), eq(issues.revision, input.revision!))).returning()
      } else {
        const number = await allocateIssueNumbers(tx, userId)
        const metadata = { ...readIssueMetadata({ type: 'doc' }), number }
        ;[issue] = await tx.insert(issues).values({ ...parsed.data, content: withIssueMetadata(parsed.data.content, metadata), id, userId, revision: 1 }).returning()
      }
      if (!issue) return { error: i18nText("FeatureCopy.c_3d114af9") }
      await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: id, userId: ownerId, revision: issue.revision, title: issue.title, content: issue.content, status: issue.status, priority: issue.priority })
      return { issue: issueWithMetadata(issue) }
    })
  } catch (error) {
    console.error(i18nText("FeatureCopy.c_80b886f7"), error instanceof Error ? error.message : 'database error')
    return { error: i18nText("Errors.issueSaveFailed") }
  }
}
export async function moveIssue(input: { id: string; status: string; revision: number }) {
  const i18nText = await getTranslations();
  const parsed = z.object({ id: z.uuid(), status: inputSchema.shape.status, revision: z.number().int().positive() }).safeParse(input)
  if (!parsed.success) return { error: i18nText("Errors.issueMoveInvalid") }
  const issue = await getIssue(parsed.data.id)
  if (issue.revision !== parsed.data.revision) return { error: i18nText("Errors.issueStale") }
  if (issue.status === parsed.data.status) return { issue }
  return saveIssue({ ...issue, status: parsed.data.status })
}

export async function changeIssuePriority(input: { id: string; priority: string; revision: number }) {
  const i18nText = await getTranslations();
  const parsed = z.object({ id: z.uuid(), priority: inputSchema.shape.priority, revision: z.number().int().positive() }).safeParse(input)
  if (!parsed.success) return { error: i18nText("Errors.issuePriorityInvalid") }
  const issue = await getIssue(parsed.data.id)
  if (issue.revision !== parsed.data.revision) return { error: i18nText("FeatureCopy.c_e3454431") }
  if (issue.priority === parsed.data.priority) return { issue }
  return saveIssue({ ...issue, priority: parsed.data.priority })
}

export async function listIssueVersions(id: string) {
  const { issue } = await requireIssueAccess(id)
  const userId = issue.userId
  return db.select().from(issueVersions).where(and(eq(issueVersions.issueId, id), eq(issueVersions.userId, userId))).orderBy(desc(issueVersions.revision)).limit(50)
}
