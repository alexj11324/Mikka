'use server'

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import * as Y from 'yjs'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import type { JSONContent } from '@tiptap/core'
import { db } from '@/lib/db'
import { issues, issueDocuments, issueMembers, issueVersions, users } from '@/lib/db/schema'
import { requireIssueAccess } from '@/lib/issue-access'
import { readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'

const encodedState = z.string().max(1_400_000).regex(/^[A-Za-z0-9+/]*={0,2}$/)
const syncSchema = z.object({ id: z.uuid(), vector: encodedState.optional(), update: encodedState.optional(), seed: encodedState.optional() })
export async function exchangeDocument(input: z.infer<typeof syncSchema>) {
  const parsed = syncSchema.parse(input)
  const { issue } = await requireIssueAccess(parsed.id)
  return db.transaction(async tx => {
    const [locked] = await tx.select({ id: issues.id, content: issues.content }).from(issues).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId))).for('update')
    if (!locked) throw new Error('任务不存在。')
    const [stored] = await tx.select().from(issueDocuments).where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.userId, issue.userId))).limit(1)
    const doc = new Y.Doc()
    try {
      if (stored) Y.applyUpdate(doc, Buffer.from(stored.state, 'base64'))
      else if (parsed.seed) Y.applyUpdate(doc, Buffer.from(parsed.seed, 'base64'))
      else throw new Error('请重新打开文档。')
      if (parsed.update) Y.applyUpdate(doc, Buffer.from(parsed.update, 'base64'))
      const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
      if (state.length > 1_400_000) throw new Error('协作文档超过 1 MB 上限，请拆分任务。')
      const content = withIssueMetadata(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')) as JSONContent, readIssueMetadata(locked.content))
      if (JSON.stringify(content).length > 250000) throw new Error('正文超过大小限制。')
      if (!stored || state !== stored.state) {
        await tx.insert(issueDocuments).values({ issueId: issue.id, userId: issue.userId, state }).onConflictDoUpdate({ target: issueDocuments.issueId, set: { state, updatedAt: new Date() } })
        await tx.update(issues).set({ content, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId)))
      }
      return { update: Buffer.from(Y.encodeStateAsUpdate(doc, parsed.vector ? Buffer.from(parsed.vector, 'base64') : undefined)).toString('base64') }
    } finally { doc.destroy() }
  })
}
export async function listMembers(id: string) {
  const { issue, user } = await requireIssueAccess(id)
  const members = await db.select({ id: users.id, name: users.name, email: users.email, image: users.image, createdAt: issueMembers.createdAt }).from(issueMembers)
    .innerJoin(users, eq(users.id, issueMembers.memberId)).where(and(eq(issueMembers.issueId, id), eq(issueMembers.userId, issue.userId))).orderBy(issueMembers.createdAt, users.id)
  const [owner] = await db.select({ id: users.id, name: users.name, email: users.email, image: users.image }).from(issues)
    .innerJoin(users, eq(users.id, issues.userId)).where(and(eq(issues.id, id), eq(issues.userId, issue.userId))).limit(1)
  if (!owner) throw new Error('任务所有者不存在。')
  return { members, owner, currentUserId: user.id, isOwner: issue.userId === user.id }
}
export async function inviteMember(id: string, email: string) {
  const { issue, user } = await requireIssueAccess(id)
  if (issue.userId !== user.id) return { error: '只有任务所有者可以管理成员。' }
  const parsed = z.email().max(254).safeParse(email.trim().toLowerCase())
  if (!parsed.success) return { error: '请填写有效邮箱。' }
  const [member] = await db.select({ id: users.id, name: users.name, email: users.email, image: users.image }).from(users).where(eq(users.email, parsed.data)).limit(1)
  if (!member || member.id === user.id) return { error: '无法添加该账号，请确认对方已注册且不是你自己。' }
  const [added] = await db.insert(issueMembers).values({ issueId: id, userId: user.id, memberId: member.id }).onConflictDoNothing().returning({ createdAt: issueMembers.createdAt })
  if (!added) return { error: '该成员已拥有此任务的访问权限，无需重复添加。' }
  return { success: true, member: { ...member, createdAt: added.createdAt } }
}
export async function removeMember(id: string, memberId: string) {
  const { issue, user } = await requireIssueAccess(id)
  if (issue.userId !== user.id) throw new Error('只有任务所有者可以管理成员。')
  z.string().min(1).max(128).parse(memberId)
  await db.transaction(async tx => {
    const [latest] = await tx.select().from(issues).where(and(eq(issues.id, id), eq(issues.userId, user.id))).for('update')
    if (!latest) throw new Error('任务不存在。')
    await tx.delete(issueMembers).where(and(eq(issueMembers.issueId, id), eq(issueMembers.userId, user.id), eq(issueMembers.memberId, memberId)))
    const metadata = readIssueMetadata(latest.content)
    if (metadata.assignee?.kind === 'member' && metadata.assignee.id === memberId) {
      const [saved] = await tx.update(issues).set({ content: withIssueMetadata(latest.content, { ...metadata, assignee: null }), revision: latest.revision + 1, updatedAt: new Date() }).where(and(eq(issues.id, id), eq(issues.userId, user.id))).returning()
      await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: id, userId: user.id, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority })
    }
  })
}
