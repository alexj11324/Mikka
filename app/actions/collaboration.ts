'use server'

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import * as Y from 'yjs'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import type { JSONContent } from '@tiptap/core'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
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
    if (!locked) throw new Error('issue not found')
    const [stored] = await tx.select().from(issueDocuments).where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.userId, issue.userId))).limit(1)
    const doc = new Y.Doc()
    try {
      if (stored) Y.applyUpdate(doc, Buffer.from(stored.state, 'base64'))
      else if (parsed.seed) Y.applyUpdate(doc, Buffer.from(parsed.seed, 'base64'))
      else throw new Error('document not initialized')
      if (parsed.update) Y.applyUpdate(doc, Buffer.from(parsed.update, 'base64'))
      const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
      if (state.length > 1_400_000) throw new Error('document exceeds 1 MB')
      const content = withIssueMetadata(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')) as JSONContent, readIssueMetadata(locked.content))
      if (JSON.stringify(content).length > 250000) throw new Error('content exceeds size limit')
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
  if (!owner) throw new Error('issue owner not found')
  return { members, owner, currentUserId: user.id, isOwner: issue.userId === user.id }
}
export async function inviteMember(id: string, email: string): Promise<ActionResult<{ success: true; member: { id: string; name: string; email: string; image: string | null; createdAt: Date } }>> {
  return runAction(async () => {
    const { issue, user } = await requireIssueAccess(id)
    if (issue.userId !== user.id) return { error: 'memberOwnerOnly' }
    const parsed = z.email().max(254).safeParse(email.trim().toLowerCase())
    if (!parsed.success) return { error: 'memberInvalidEmail' }
    const [member] = await db.select({ id: users.id, name: users.name, email: users.email, image: users.image }).from(users).where(eq(users.email, parsed.data)).limit(1)
    if (!member || member.id === user.id) return { error: 'memberNotRegistered' }
    const [added] = await db.insert(issueMembers).values({ issueId: id, userId: user.id, memberId: member.id }).onConflictDoNothing().returning({ createdAt: issueMembers.createdAt })
    if (!added) return { error: 'memberAlreadyAdded' }
    return { success: true, member: { ...member, createdAt: added.createdAt } }
  })
}
export async function removeMember(id: string, memberId: string): Promise<ActionResult<{ success: true }>> {
  return runAction(async () => {
    const { issue, user } = await requireIssueAccess(id)
    if (issue.userId !== user.id) return { error: 'memberOwnerOnly' }
    const parsed = z.string().min(1).max(128).safeParse(memberId)
    if (!parsed.success) return { error: 'validationGeneric' }
    await db.transaction(async tx => {
      const [latest] = await tx.select().from(issues).where(and(eq(issues.id, id), eq(issues.userId, user.id))).for('update')
      if (!latest) throw new ActionFailureError('issueNotFound')
      await tx.delete(issueMembers).where(and(eq(issueMembers.issueId, id), eq(issueMembers.userId, user.id), eq(issueMembers.memberId, parsed.data)))
      const metadata = readIssueMetadata(latest.content)
      if (metadata.assignee?.kind === 'member' && metadata.assignee.id === parsed.data) {
        const [saved] = await tx.update(issues).set({ content: withIssueMetadata(latest.content, { ...metadata, assignee: null }), revision: latest.revision + 1, updatedAt: new Date() }).where(and(eq(issues.id, id), eq(issues.userId, user.id))).returning()
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: id, userId: user.id, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority })
      }
    })
    return { success: true }
  })
}
