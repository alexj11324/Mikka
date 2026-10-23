import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { issueDocuments, issues, linearCommentLinks, linearConnections, linearIssueLinks } from '@/lib/db/schema'
import { hashValue } from './crypto'
import { createLinearComment, linearComment, updateLinearComment } from './client'
import { linearAccessToken } from './tokens'
import { loadIssueDocument, readIssueThreadMessage, readIssueThreads } from './document'
import { linearMarkdownToPlainText, plainTextToLinearMarkdown } from './markdown'
import { upsertLinearComment } from './document'
import { persistedCommentAuthorMatches } from './comment-authorship'
import * as Y from 'yjs'

type IssueRow = typeof issues.$inferSelect
type IssueLink = typeof linearIssueLinks.$inferSelect

async function commentToken(ownerId: string, authorId: string | undefined, organizationId: string, ownerToken: string) {
  if (!authorId || authorId === ownerId) return ownerToken
  const [connection] = await db.select({ organizationId: linearConnections.organizationId }).from(linearConnections)
    .where(eq(linearConnections.userId, authorId)).limit(1)
  if (!connection || connection.organizationId !== organizationId) return ownerToken
  try { return await linearAccessToken(authorId) } catch { return ownerToken }
}

async function externalCommentExists(token: string, commentId: string, issueId: string) {
  try {
    const remote = await linearComment(token, commentId)
    return remote?.issue?.id === issueId
  } catch { return false }
}

export async function linearCommentSync(issue: IssueRow, issueLink: IssueLink, state: string | null, ownerToken: string, organizationId: string) {
  const doc = loadIssueDocument(state, issue.content)
  try {
    const threads = readIssueThreads(doc)
    if (!threads.length) return
    const existing = await db.select().from(linearCommentLinks).where(eq(linearCommentLinks.issueLinkId, issueLink.id))
    const byLocalId = new Map(existing.map(link => [`${link.threadId}\0${link.messageId}`, link]))

    for (const thread of threads) {
      let rootCommentId: string | undefined
      for (const [index, message] of thread.messages.entries()) {
        if (!message.body.trim()) continue
        let link = byLocalId.get(`${thread.id}\0${message.id}`)
        if (link?.syncStatus === 'remote_removed') continue
        const parentId = index === 0 ? undefined : rootCommentId
        if (link) {
          rootCommentId ??= index === 0 ? link.linearCommentId : undefined
          if (!persistedCommentAuthorMatches(link.authorUserId, message.authorUserId)) throw new Error('Comment author does not match its saved Linear mapping')
          if (link.syncStatus === 'synced' && link.bodyHash === hashValue(message.body)) continue
          if (!link.authorUserId) throw new Error('A Linear-authored comment cannot be edited from Mikka')
          const token = await commentToken(issue.userId, link.authorUserId, organizationId, ownerToken)
          const exists = await externalCommentExists(token, link.linearCommentId, issueLink.linearIssueId)
          if (exists) {
            await updateLinearComment(token, link.linearCommentId, plainTextToLinearMarkdown(message.body))
          } else {
            const created = await createLinearComment(token, { id: link.linearCommentId, issueId: issueLink.linearIssueId, body: plainTextToLinearMarkdown(message.body), ...(parentId ? { parentId } : {}) }).catch(async error => {
              if (await externalCommentExists(token, link!.linearCommentId, issueLink.linearIssueId)) return { id: link!.linearCommentId }
              throw error
            })
            link = { ...link, linearCommentId: created.id }
          }
          await db.update(linearCommentLinks).set({ bodyHash: hashValue(message.body), syncStatus: 'synced', lastError: null, updatedAt: new Date() }).where(eq(linearCommentLinks.id, link.id))
          if (index === 0) rootCommentId = link.linearCommentId
          continue
        }

        const linearCommentId = crypto.randomUUID()
        const [inserted] = await db.insert(linearCommentLinks).values({
          id: crypto.randomUUID(), issueLinkId: issueLink.id, threadId: thread.id, messageId: message.id,
          linearCommentId, parentLinearCommentId: parentId ?? null, bodyHash: hashValue(message.body), authorUserId: message.authorUserId ?? null, syncStatus: 'pending',
        }).onConflictDoNothing().returning()
        link = inserted ?? byLocalId.get(`${thread.id}\0${message.id}`)
        if (!link) throw new Error('Could not reserve the Linear comment mapping')
        byLocalId.set(`${thread.id}\0${message.id}`, link)
        rootCommentId ??= index === 0 ? link.linearCommentId : undefined

        const token = await commentToken(issue.userId, message.authorUserId, organizationId, ownerToken)
        let created: { id: string }
        if (await externalCommentExists(token, link.linearCommentId, issueLink.linearIssueId)) created = { id: link.linearCommentId }
        else created = await createLinearComment(token, { id: link.linearCommentId, issueId: issueLink.linearIssueId, body: plainTextToLinearMarkdown(message.body), ...(parentId ? { parentId } : {}) }).catch(async error => {
          if (await externalCommentExists(token, link!.linearCommentId, issueLink.linearIssueId)) return { id: link!.linearCommentId }
          await db.update(linearCommentLinks).set({ syncStatus: 'error', lastError: error instanceof Error ? error.message.slice(0, 300) : 'Linear comment sync failed', updatedAt: new Date() }).where(eq(linearCommentLinks.id, link!.id))
          throw error
        })
        await db.update(linearCommentLinks).set({ linearCommentId: created.id, syncStatus: 'synced', lastError: null, bodyHash: hashValue(message.body), updatedAt: new Date() }).where(eq(linearCommentLinks.id, link.id))
        if (index === 0) rootCommentId = created.id
      }
    }
  } finally { doc.destroy() }
}

export async function applyLinearCommentToApp(input: {
  issue: IssueRow
  issueLink: IssueLink
  id: string
  body: string
  author: string
  parentId: string | null
  createdAt: string
  action: string
}) {
  const [existing] = await db.select().from(linearCommentLinks).where(eq(linearCommentLinks.linearCommentId, input.id)).limit(1)
  if (input.action === 'remove') {
    if (existing) await db.update(linearCommentLinks).set({ syncStatus: 'remote_removed', lastError: null, updatedAt: new Date() }).where(eq(linearCommentLinks.id, existing.id))
    return
  }
  if (existing?.authorUserId) {
    const [stored] = await db.select({ state: issueDocuments.state }).from(issueDocuments).where(eq(issueDocuments.issueId, input.issue.id)).limit(1)
    const doc = loadIssueDocument(stored?.state ?? null, input.issue.content)
    try {
      const local = readIssueThreadMessage(doc, existing.threadId, existing.messageId)
      if (local && existing.bodyHash !== hashValue(local.body)) return
      if (local && input.body === plainTextToLinearMarkdown(local.body)) {
        await db.update(linearCommentLinks).set({ syncStatus: 'synced', lastError: null, updatedAt: new Date() }).where(eq(linearCommentLinks.id, existing.id))
        return
      }
    } finally { doc.destroy() }
  }
  let threadId = existing?.threadId
  if (!threadId && input.parentId) {
    const [parent] = await db.select({ threadId: linearCommentLinks.threadId }).from(linearCommentLinks).where(eq(linearCommentLinks.linearCommentId, input.parentId)).limit(1)
    threadId = parent?.threadId
  }
  threadId ??= `discussion-${input.id}`
  const messageId = existing?.messageId ?? `${threadId}-linear-${input.id}`
  const body = linearMarkdownToPlainText(input.body)
  if (body.length > 2000) throw new Error('Linear comment is larger than Mikka supports')
  await db.transaction(async tx => {
    await tx.execute(sql`select set_config('orvilo.linear_sync_source', 'linear', true)`)
    const [latestIssue] = await tx.select({ updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, input.issue.id)).for('update').limit(1)
    const [currentLink] = await tx.select({ appSyncedAt: linearIssueLinks.appSyncedAt }).from(linearIssueLinks).where(eq(linearIssueLinks.id, input.issueLink.id)).for('update').limit(1)
    if (!latestIssue || !currentLink) return
    const nextUpdatedAt = new Date()
    const [stored] = await tx.select({ state: issueDocuments.state }).from(issueDocuments).where(eq(issueDocuments.issueId, input.issue.id)).for('update').limit(1)
    const doc = loadIssueDocument(stored?.state ?? null, input.issue.content)
    try {
      // External comments remain discussion threads; inline anchors are app-owned.
      const safeAuthor = input.author || 'Linear user'
      upsertLinearComment(doc, { threadId: threadId!, messageId, author: safeAuthor, body, at: input.createdAt })
      const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
      if (state.length > 1_400_000) throw new Error('Issue collaboration data exceeds the supported size')
      await tx.insert(issueDocuments).values({ issueId: input.issue.id, userId: input.issue.userId, state, updatedAt: new Date() })
        .onConflictDoUpdate({ target: issueDocuments.issueId, set: { state, updatedAt: new Date() } })
      await tx.update(issues).set({ updatedAt: nextUpdatedAt }).where(eq(issues.id, input.issue.id))
      if (currentLink.appSyncedAt && latestIssue.updatedAt <= currentLink.appSyncedAt) {
        await tx.update(linearIssueLinks).set({ appSyncedAt: nextUpdatedAt, updatedAt: nextUpdatedAt }).where(eq(linearIssueLinks.id, input.issueLink.id))
      }
      if (!existing) await tx.insert(linearCommentLinks).values({
        id: crypto.randomUUID(), issueLinkId: input.issueLink.id, threadId: threadId!, messageId,
        linearCommentId: input.id, parentLinearCommentId: input.parentId, bodyHash: hashValue(body), syncStatus: 'synced',
      }).onConflictDoNothing()
      else await tx.update(linearCommentLinks).set({ bodyHash: hashValue(body), syncStatus: 'synced', lastError: null, updatedAt: new Date() }).where(eq(linearCommentLinks.id, existing.id))
    } finally { doc.destroy() }
  })
}
