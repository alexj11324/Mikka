import 'server-only'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { issueComments, issueLinks, issueSeen, users } from '@/lib/db/schema'
import { requireIssueAccess, requireIssueAccessWithoutBody } from '@/lib/issue-access'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { withIssueWorkspace } from '@/lib/issue-scope-authorization'
import { setIssueSubscribed } from '@/lib/issue-subscription'
import type { IssueCommentFile } from '@/lib/db/schema'
import { foldComments, normalizeLinkTarget } from '@/lib/issue-comment-tree'

/**
 * A task's collaboration surface: its comments (with replies), the caller's seen
 * marker, its external links, and the two counters Capy's issue list shows.
 *
 * Reached from app/api/issues/[id]/comments and .../seen and .../links, and from
 * the task page through the same access rules every other task read uses
 * (requireIssueAccess + withIssueWorkspace), so a comment is never readable by
 * someone who cannot read the task.
 */

/** A comment as the API returns it: flat, with `parentId` naming its reply target. */
export type IssueCommentView = {
  id: string
  parentId: string | null
  author: { id: string; name: string; image: string | null; type: 'user' | 'agent' | 'system'; deleted: boolean }
  body: string
  files: IssueCommentFile[]
  createdAt: string
  updatedAt: string
  /** Soft-deleted: the row is kept so its replies keep their parent, and a reader draws the gap. */
  deleted: boolean
  /** Its replies, oldest first. Present on a top-level comment; empty on a reply. */
  replies: IssueCommentView[]
}

export const commentBodySchema = z.string().trim().min(1).max(20000)
export const commentFilesSchema = z.array(z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  contentType: z.string().min(1).max(200),
  size: z.number().int().nonnegative().max(100 * 1024 * 1024),
})).max(20).default([])

/** POST :code/comments — exactly Capy's CommentIssueRequest: { body, replyTo?, files? }. */
export const commentRequestSchema = z.object({
  body: commentBodySchema,
  /** The comment this one answers. Absent: a top-level comment. */
  replyTo: z.uuid().nullish(),
  files: commentFilesSchema,
})

/** PUT :code/subscription — Capy's SetSubscriptionRequest: { subscribed }. */
export const subscriptionRequestSchema = z.object({ subscribed: z.boolean() })

/** POST :code/links — Capy's LinkIssueRequest: { ref }. */
export const linkRequestSchema = z.object({ ref: z.string().trim().min(1).max(2000) })

/** DELETE :code/links — Capy's UnlinkIssueRequest: { target }. */
export const unlinkRequestSchema = z.object({ target: z.string().trim().min(1).max(2000) })

/** The comment tree for one task, as the page draws it: top-level comments oldest first, each with its replies. */
export async function listIssueComments(issueId: string): Promise<{ comments: IssueCommentView[]; total: number }> {
  const rows = await db.select({
    id: issueComments.id, parentId: issueComments.parentId, body: issueComments.body, files: issueComments.files,
    createdAt: issueComments.createdAt, updatedAt: issueComments.updatedAt, deletedAt: issueComments.deletedAt,
    authorId: issueComments.authorId, authorType: issueComments.authorType,
    authorName: users.name, authorEmail: users.email, authorImage: users.image,
  }).from(issueComments)
    .leftJoin(users, eq(users.id, issueComments.authorId))
    .where(eq(issueComments.issueId, issueId))
    // Oldest first, as the page reads; a reply arrives after its parent because
    // a parent is written before the reply that names it.
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id))

  const view = (row: typeof rows[number]): IssueCommentView => {
    const deleted = row.deletedAt !== null
    return {
      id: row.id, parentId: row.parentId,
      author: {
        id: row.authorId,
        // A deleted account's comment keeps its words and loses its name, rather
        // than disappearing: the reply thread it holds must stay readable.
        name: row.authorName ?? row.authorEmail ?? '',
        image: row.authorImage,
        type: row.authorType,
        deleted: row.authorName === null,
      },
      // A soft-deleted comment's body is withheld; the row itself still marks the gap.
      body: deleted ? '' : row.body,
      files: deleted ? [] : row.files,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      deleted, replies: [],
    }
  }

  // Flat rows ordered oldest first, folded into the one level of nesting the page
  // draws (the template's `comment: true`); lib/issue-comment-tree.ts holds the rule.
  const comments = foldComments(rows.map(row => view(row))) as IssueCommentView[]
  return { comments, total: rows.length }
}

/** Fetches a task's comments with the caller's access checks, for the task page. */
export async function readIssueComments(issueId: string) {
  const { issue } = await requireIssueAccessWithoutBody(issueId)
  return { ...(await listIssueComments(issue.id)), issueId: issue.id }
}

/**
 * Adds a comment, or a reply when `replyTo` names one. Both the reply target and
 * the task are checked: a reply may only join a comment on this same task, so a
 * caller cannot graft a reply onto another task's thread by guessing an id.
 */
export async function createIssueComment(issueId: string, input: z.infer<typeof commentRequestSchema>) {
  const { issue, user } = await requireIssueAccess(issueId)
  const parsed = commentRequestSchema.safeParse(input)
  if (!parsed.success) throw new ActionFailureError('issueCommentInvalid')
  const { body, replyTo, files } = parsed.data
  return withIssueWorkspace(user, issue.workspaceId, { issueId: issue.id, action: 'canSteer' }, async (_workspace, tx) => {
    if (replyTo) {
      const [parent] = await tx.select({ id: issueComments.id, issueId: issueComments.issueId })
        .from(issueComments).where(eq(issueComments.id, replyTo)).limit(1)
      // A reply target that is not this task's comment is indistinguishable from
      // one that does not exist, so neither confirms the other task exists.
      if (!parent || parent.issueId !== issue.id) throw new ActionFailureError('issueCommentReplyTargetNotFound')
    }
    const id = crypto.randomUUID()
    const [row] = await tx.insert(issueComments).values({
      id, issueId: issue.id, authorId: user.id, authorType: 'user', body, parentId: replyTo ?? null, files,
    }).returning({ id: issueComments.id, createdAt: issueComments.createdAt })
    return { id: row.id, createdAt: row.createdAt.toISOString(), parentId: replyTo ?? null }
  })
}

/** Marks the task seen for the caller. Idempotent: looking twice only moves the time forward. */
export async function markIssueSeen(issueId: string) {
  const { issue, user } = await requireIssueAccess(issueId)
  return withIssueWorkspace(user, issue.workspaceId, { issueId: issue.id, action: 'canReadContent' }, async (_workspace, tx) => {
    const seenAt = new Date()
    await tx.insert(issueSeen).values({ issueId: issue.id, userId: user.id, seenAt })
      .onConflictDoUpdate({ target: [issueSeen.issueId, issueSeen.userId], set: { seenAt } })
    // The answer carries the counters the page shows, so one visit refreshes both.
    return { seenAt: seenAt.toISOString(), ...(await issueCounts(tx, user.id)) }
  })
}

/** The caller's subscription to the task: whether they hear about it. */
export async function setIssueSubscription(issueId: string, subscribed: boolean) {
  const { issue, user } = await requireIssueAccess(issueId)
  return withIssueWorkspace(user, issue.workspaceId, { issueId: issue.id, action: 'canReadContent' }, async (_workspace, tx) => {
    // The single fact is metadata.subscriberUserIds, the same array the ⋯ menu
    // toggles and the 关注 filter reads, so one visit and one filter never disagree.
    return { subscribed: await setIssueSubscribed(tx, user.id, issue.id, subscribed) }
  })
}

/** Adds an external reference to the task. Idempotent by normalized target. */
export async function addIssueLink(issueId: string, input: z.infer<typeof linkRequestSchema>) {
  const { issue, user } = await requireIssueAccess(issueId)
  const parsed = linkRequestSchema.safeParse(input)
  if (!parsed.success) throw new ActionFailureError('issueLinkInvalid')
  const target = normalizeLinkTarget(parsed.data.ref)
  if (!target) throw new ActionFailureError('issueLinkInvalid')
  return withIssueWorkspace(user, issue.workspaceId, { issueId: issue.id, action: 'canSteer' }, async (_workspace, tx) => {
    const [row] = await tx.insert(issueLinks).values({ id: crypto.randomUUID(), issueId: issue.id, ref: parsed.data.ref, target })
      .onConflictDoUpdate({ target: [issueLinks.issueId, issueLinks.target], set: { ref: parsed.data.ref } })
      .returning({ id: issueLinks.id, ref: issueLinks.ref, target: issueLinks.target, createdAt: issueLinks.createdAt })
    return { id: row.id, ref: row.ref, target: row.target, createdAt: row.createdAt.toISOString() }
  })
}

/** Removes an external reference by its normalized target. Removing one that is not there is not an error. */
export async function removeIssueLink(issueId: string, input: z.infer<typeof unlinkRequestSchema>) {
  const { issue, user } = await requireIssueAccess(issueId)
  const parsed = unlinkRequestSchema.safeParse(input)
  if (!parsed.success) throw new ActionFailureError('issueLinkInvalid')
  const target = normalizeLinkTarget(parsed.data.target)
  return withIssueWorkspace(user, issue.workspaceId, { issueId: issue.id, action: 'canSteer' }, async (_workspace, tx) => {
    if (target) await tx.delete(issueLinks).where(and(eq(issueLinks.issueId, issue.id), eq(issueLinks.target, target)))
    return { removed: true as const }
  })
}

/** A task's external links, newest first. */
export async function listIssueLinks(issueId: string) {
  const rows = await db.select({ id: issueLinks.id, ref: issueLinks.ref, target: issueLinks.target, createdAt: issueLinks.createdAt })
    .from(issueLinks).where(eq(issueLinks.issueId, issueId)).orderBy(desc(issueLinks.createdAt))
  return { links: rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })) }
}

/**
 * The two counters Capy's issue list shows.
 *
 * assigned: tasks assigned to the caller that are still open. `assigned` is
 * metadata.assignee, whose `kind` distinguishes a member from an agent.
 *
 * mentions: comments on a task the caller can read, written by someone else,
 * after the caller's seen marker there. Mikka's document comments cannot be
 * parsed for an @-mention, so a mention is a comment that arrived since the
 * caller last looked — the same shape Capy derives from `IssueViewer.mentions`.
 */
export type IssueCounts = { assigned: number; mentions: number }

export async function issueCounts(executor: Pick<typeof db, 'select' | 'execute'>, userId: string): Promise<IssueCounts> {
  const visible = sql`i."workspaceId" is not null and i."ownershipState"='bound'
    and coalesce(i.content->'attrs'->'mikka', i.content->'attrs'->'orvilo')->>'deletedAt' is null
    and mikka_resource_acl_allowed('account', ${userId}, i."workspaceId", 'task', i.id, 'canReadMetadata')`
  const assigned = await executor.execute<{ count: string }>(sql`
    select count(*)::text as count from issues i
    where ${visible}
      and i.content->'attrs'->'mikka'->'assignee'->>'kind' = 'member'
      and i.content->'attrs'->'mikka'->'assignee'->>'id' = ${userId}
      and coalesce(i.status, '') not in ('done', 'canceled', 'duplicate')
  `)
  // A mention needs a baseline to be "since": the reader's own seen marker on
  // that task. A task this account has never opened contributes nothing, so a new
  // account does not start with a badge counting the history of every task it can
  // read — the one thing a count of "new since you looked" must not do. Removing
  // the seen row (a task this reader never opened) therefore drops its comments
  // out of the count rather than pulling the whole history in.
  const mentions = await executor.execute<{ count: string }>(sql`
    select count(*)::text as count from issue_comments c
    join issues i on i.id = c."issueId"
    join issue_seen s on s."issueId" = c."issueId" and s."userId" = ${userId}
    where ${visible}
      and c."authorId" <> ${userId}
      and c."deletedAt" is null
      and c."createdAt" > s."seenAt"
  `)
  return { assigned: Number(assigned.rows[0]?.count ?? 0), mentions: Number(mentions.rows[0]?.count ?? 0) }
}

/** The counters for the signed-in account, for the API route. */
export async function readIssueCounts(userId: string): Promise<IssueCounts> {
  return issueCounts(db, userId)
}

/** Whether a task's metadata still names the caller as an assignee, for the page's own quiet display. */
export function isAssignedTo(issue: { content: Parameters<typeof readIssueMetadata>[0] }, userId: string) {
  const assignee = readIssueMetadata(issue.content).assignee
  return assignee?.kind === 'member' && assignee.id === userId
}
