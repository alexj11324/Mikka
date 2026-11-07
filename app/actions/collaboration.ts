'use server'

import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import * as Y from 'yjs'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import type { JSONContent } from '@tiptap/core'
import { runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { db, pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { documentChanged, documentLiveWorkspace } from '@/lib/live/panels'
import { issues, issueDocuments, issueMembers, issueVersions, linearIssueLinks, users } from '@/lib/db/schema'
import { requireIssueAccess, requireIssueAccessWithoutBody } from '@/lib/issue-access'
import { readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'
import { dispatchLinearIssueSync } from '@/lib/linear-sync/dispatch'
import { bindCommentAuthorship, snapshotCommentAuthorship } from '@/lib/linear-sync/comment-authorship'
import { activityActor } from '@/lib/activity-actor'
import { requireCurrentIssueWorkspace, requireLockedIssueScope, withIssueWorkspace } from '@/lib/issue-scope-authorization'
import { readableIssueContentOnServer as readableIssueContent } from '@/lib/issue-editor-schema-snapshot'
import { issueListChanged } from '@/lib/live/lists'
import { issueMembersChanged } from '@/lib/live/issue-detail'

const encodedState = z.string().max(1_400_000).regex(/^[A-Za-z0-9+/]*={0,2}$/)
const syncSchema = z.object({ id: z.uuid(), vector: encodedState.optional(), update: encodedState.optional(), seed: encodedState.optional(), known: z.string().regex(/^[0-9a-f]{32}$/).optional() })
/** The stored document's version: md5 of its state, as Postgres md5(state) computes it. */
const documentVersion = (state: string) => createHash('md5').update(state).digest('hex')
/**
 * Sync the task body. A poll with no local edits passes the version it last
 * received (`known`); while the stored document still has that version, the
 * answer carries the version and authorized live workspace, never the body or state.
 */
export async function exchangeDocument(input: z.infer<typeof syncSchema>): Promise<{ update?: string; version: string; workspaceId: string | null }> {
  const parsed = syncSchema.parse(input)
  const { issue, user } = await requireIssueAccessWithoutBody(parsed.id)
  const workspaceId = await documentLiveWorkspace(pool, workspacePool, issue.id, user.id)
  if (parsed.known && !parsed.update) {
    const [current] = await db.select({ version: sql<string>`md5(${issueDocuments.state})` }).from(issueDocuments)
      .where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.userId, issue.userId))).limit(1)
    if (current?.version === parsed.known) {
      await requireCurrentIssueWorkspace(user, issue.workspaceId)
      return { version: current.version, workspaceId }
    }
  }
  const writing = parsed.update !== undefined || parsed.seed !== undefined
  const exchange = () => db.transaction(async tx => {
    const [locked] = await tx.select({ id: issues.id, userId: issues.userId, scopeVersion: issues.scopeVersion, workspaceId: issues.workspaceId, content: issues.content, scope: issues.scope, linearSyncPolicy: issues.linearSyncPolicy, linearSyncBlocked: issues.linearSyncBlocked }).from(issues).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId))).for('update')
    requireLockedIssueScope(locked, user.id, issue.scopeVersion, issue.workspaceId)
    if (!writing) await requireCurrentIssueWorkspace(user, issue.workspaceId)
    const [stored] = await tx.select().from(issueDocuments).where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.userId, issue.userId))).limit(1)
    const doc = new Y.Doc()
    try {
      if (stored) Y.applyUpdate(doc, Buffer.from(stored.state, 'base64'))
      const commentAuthors = snapshotCommentAuthorship(doc)
      // The first exchange seeds from issues.content. If that content fails the editor schema, any seed is an
      // empty/lossy stand-in for it, so refuse instead of overwriting the body (the client stays read-only).
      if (!stored && !readableIssueContent(locked.content, issue.id)) throw new Error('document content invalid')
      if (!stored && parsed.seed) Y.applyUpdate(doc, Buffer.from(parsed.seed, 'base64'))
      else if (!stored) throw new Error('document not initialized')
      if (parsed.update) Y.applyUpdate(doc, Buffer.from(parsed.update, 'base64'))
      if (writing) bindCommentAuthorship(doc, commentAuthors, { id: user.id, name: user.name || user.email })
      // A pure read never normalizes persisted Y state as a side effect. Its
      // fresh membership check needs no WS lock while holding the APP row.
      const state = !writing && stored ? stored.state : Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
      if (state.length > 1_400_000) throw new Error('document exceeds 1 MB')
      const content = withIssueMetadata(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')) as JSONContent, readIssueMetadata(locked.content))
      if (JSON.stringify(content).length > 250000) throw new Error('content exceeds size limit')
      const changed = writing && (!stored || state !== stored.state)
      if (changed) {
        await tx.insert(issueDocuments).values({ issueId: issue.id, userId: issue.userId, state }).onConflictDoUpdate({ target: issueDocuments.issueId, set: { state, updatedAt: new Date() } })
        await tx.update(issues).set({ content, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId)))
        await documentChanged(tx, issue.id)
        await issueListChanged(tx, issue.id)
      }
      const [link] = locked.linearSyncPolicy === 'explicit' && !locked.linearSyncBlocked ? await tx.select({ id: linearIssueLinks.id }).from(linearIssueLinks).where(and(eq(linearIssueLinks.issueId, locked.id), eq(linearIssueLinks.ownerId, issue.userId), eq(linearIssueLinks.externalTargetVerified, true))).limit(1) : []
      return { changed, syncEligible: Boolean(link), version: documentVersion(state), update: Buffer.from(Y.encodeStateAsUpdate(doc, parsed.vector ? Buffer.from(parsed.vector, 'base64') : undefined)).toString('base64') }
    } finally { doc.destroy() }
  })
  const result = writing ? await withIssueWorkspace(user, issue.workspaceId, exchange) : await exchange()
  if (result.changed && result.syncEligible) dispatchLinearIssueSync(issue.id)
  return { update: result.update, version: result.version, workspaceId }
}
export async function listMembers(id: string) {
  const { issue, user } = await requireIssueAccess(id)
  const result = await db.transaction(async tx => {
  const [locked] = await tx.select({ userId: issues.userId, scope: issues.scope, workspaceId: issues.workspaceId, scopeVersion: issues.scopeVersion }).from(issues).where(eq(issues.id, id)).for('share')
  requireLockedIssueScope(locked, user.id, issue.scopeVersion, issue.workspaceId)
  await requireCurrentIssueWorkspace(user, issue.workspaceId)
  const members = await tx.select({ id: users.id, name: users.name, email: users.email, image: users.image, createdAt: issueMembers.createdAt }).from(issueMembers)
    .innerJoin(users, eq(users.id, issueMembers.memberId)).where(and(eq(issueMembers.issueId, id), eq(issueMembers.userId, issue.userId))).orderBy(issueMembers.createdAt, users.id)
  const [owner] = await tx.select({ id: users.id, name: users.name, email: users.email, image: users.image }).from(issues)
    .innerJoin(users, eq(users.id, issues.userId)).where(and(eq(issues.id, id), eq(issues.userId, issue.userId))).limit(1)
  if (!owner) throw new Error('issue owner not found')
  return { members, owner, currentUserId: user.id, isOwner: issue.userId === user.id }
  })
  // The channel its `issue_members` key arrives on; null reads once a minute.
  return { ...result, live: { workspaceId: await documentLiveWorkspace(pool, workspacePool, issue.id, user.id) } }
}
export async function inviteMember(id: string, email: string): Promise<ActionResult<{ success: true; member: { id: string; name: string; email: string; image: string | null; createdAt: Date } }>> {
  return runAction(async () => {
    const { issue, user } = await requireIssueAccess(id)
    if (issue.userId !== user.id) return { error: 'memberOwnerOnly' }
    const parsed = z.email().max(254).safeParse(email.trim().toLowerCase())
    if (!parsed.success) return { error: 'memberInvalidEmail' }
    return withIssueWorkspace(user, issue.workspaceId, () => db.transaction(async tx => {
      const [locked] = await tx.select({ workspaceId: issues.workspaceId, scopeVersion: issues.scopeVersion }).from(issues).where(and(eq(issues.id, id), eq(issues.userId, user.id))).for('update')
      requireLockedIssueScope(locked, user.id, issue.scopeVersion, issue.workspaceId)
      const [member] = await tx.select({ id: users.id, name: users.name, email: users.email, image: users.image }).from(users).where(eq(users.email, parsed.data)).limit(1)
      if (!member || member.id === user.id) return { error: 'memberNotRegistered' }
      const [added] = await tx.insert(issueMembers).values({ issueId: id, userId: user.id, memberId: member.id }).onConflictDoNothing().returning({ createdAt: issueMembers.createdAt })
      if (!added) return { error: 'memberAlreadyAdded' }
      await issueMembersChanged(tx, id)
      return { success: true, member: { ...member, createdAt: added.createdAt } }
    }))
  })
}
export async function removeMember(id: string, memberId: string): Promise<ActionResult<{ success: true }>> {
  return runAction(async () => {
    const { issue, user } = await requireIssueAccess(id)
    if (issue.userId !== user.id) return { error: 'memberOwnerOnly' }
    const parsed = z.string().min(1).max(128).safeParse(memberId)
    if (!parsed.success) return { error: 'validationGeneric' }
    const clearedAssignee = await withIssueWorkspace(user, issue.workspaceId, () => db.transaction(async tx => {
      const [latest] = await tx.select().from(issues).where(and(eq(issues.id, id), eq(issues.userId, user.id))).for('update')
      requireLockedIssueScope(latest, user.id, issue.scopeVersion, issue.workspaceId)
      const removed = await tx.delete(issueMembers).where(and(eq(issueMembers.issueId, id), eq(issueMembers.userId, user.id), eq(issueMembers.memberId, parsed.data))).returning({ memberId: issueMembers.memberId })
      if (removed.length) await issueMembersChanged(tx, id)
      const metadata = readIssueMetadata(latest.content)
      if (metadata.assignee?.kind === 'member' && metadata.assignee.id === parsed.data) {
        const [saved] = await tx.update(issues).set({ content: withIssueMetadata(latest.content, { ...metadata, assignee: null }), revision: latest.revision + 1, updatedAt: new Date() }).where(and(eq(issues.id, id), eq(issues.userId, user.id))).returning()
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: id, userId: user.id, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, ...activityActor(user.id) })
        await issueListChanged(tx, id)
        if (saved.linearSyncPolicy !== 'explicit' || saved.linearSyncBlocked) return false
        const [link] = await tx.select({ id: linearIssueLinks.id }).from(linearIssueLinks).where(and(eq(linearIssueLinks.issueId, saved.id), eq(linearIssueLinks.ownerId, saved.userId), eq(linearIssueLinks.externalTargetVerified, true))).limit(1)
        return Boolean(link)
      }
      return false
    }))
    if (clearedAssignee) dispatchLinearIssueSync(id)
    return { success: true }
  })
}
