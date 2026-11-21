import { and, eq } from 'drizzle-orm'
import { db } from './db'
import { issues, issueVersions } from './db/schema'
import { type IssueMetadata, withIssueMetadata } from './issue-metadata'
import type { ActivityActor } from './activity-actor'
import { reviewTaskChanged } from './coding-workspace/review-sessions'
import { issueListChanged } from './live/lists'
import { issueRelationsChanged, relationIds } from './live/issue-detail'

type Executor = Pick<typeof db, 'update' | 'insert'>
type Issue = typeof issues.$inferSelect

/** The caller admits and locks the task. A metadata change, its revision and
 * its existing activity/live effects are one commit. */
export async function persistIssueMetadata(tx: Executor, issue: Issue, metadata: IssueMetadata, actor: ActivityActor) {
  const [saved] = await tx.update(issues).set({ content: withIssueMetadata(issue.content, metadata), revision: issue.revision + 1, updatedAt: new Date() })
    .where(and(eq(issues.id, issue.id),eq(issues.userId,issue.userId),eq(issues.revision,issue.revision))).returning()
  if (!saved) return null
  reviewTaskChanged(tx, issue, saved)
  await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: saved.id, userId: saved.userId, revision: saved.revision,
    title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, ...actor })
  await issueListChanged(tx,saved.id)
  await issueRelationsChanged(tx,[saved.id,...relationIds(issue.content),...relationIds(saved.content)])
  return saved
}
