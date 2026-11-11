import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'
import { issueListChanged } from '@/lib/live/lists'

/**
 * Whether an account hears about a task, and the one place that changes it.
 *
 * The fact lives in the task's own metadata (`subscriberUserIds`), which the ⋯
 * menu's 订阅 item, the 关注 filter and the workspace overview already read
 * (components/workspace/issue-detail-actions.tsx, issue-workspace.tsx,
 * workspace-overview.tsx). Making the API's PUT :code/subscription write the
 * same array is what keeps one visit and one filter from disagreeing; a second
 * table would be a second answer to the same question.
 */

/** The metadata list's own cap, from metadataSchema.subscriberUserIds.max(200). */
const SUBSCRIBER_LIMIT = 200

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Sets the caller's subscription to exactly `subscribed` inside the caller's
 * transaction. Unlike toggleIssuePreference this is idempotent, so a retried
 * request, a page that sends the state it already shows, and two devices
 * agreeing all land on the same answer.
 *
 * Taking the caller's transaction is deliberate: the API route already holds the
 * task's workspace lease there, and a second connection would take the task
 * row's lock on a different session than the one that leased it.
 */
export async function setIssueSubscribed(tx: Transaction, userId: string, issueId: string, subscribed: boolean): Promise<boolean> {
  // The row lock keeps a concurrent favourite (which rewrites the same content)
  // from losing this change, as toggleIssuePreference does for its own writes.
  const [latest] = await tx.select().from(issues).where(eq(issues.id, issueId)).for('update')
  if (!latest) return false
  const metadata = readIssueMetadata(latest.content)
  const present = metadata.subscriberUserIds.includes(userId)
  if (present === subscribed) return subscribed
  // Beyond the cap the task stays readable; only the new subscription is refused,
  // and the caller is told the state they actually have rather than a promise.
  if (subscribed && metadata.subscriberUserIds.length >= SUBSCRIBER_LIMIT) return present
  const next = subscribed
    ? [...metadata.subscriberUserIds, userId]
    : metadata.subscriberUserIds.filter(id => id !== userId)
  const [saved] = await tx.update(issues)
    .set({ content: withIssueMetadata(latest.content, { ...metadata, subscriberUserIds: next }), revision: latest.revision + 1 })
    .where(and(eq(issues.id, issueId), eq(issues.revision, latest.revision))).returning({ id: issues.id })
  if (!saved) return present
  await issueListChanged(tx, issueId)
  return subscribed
}

/** Whether the account currently hears about the task. */
export function readsSubscription(content: Parameters<typeof readIssueMetadata>[0], userId: string): boolean {
  return readIssueMetadata(content).subscriberUserIds.includes(userId)
}
