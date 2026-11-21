import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from './db'
import { issueDocuments, issues } from './db/schema'
import { loadIssueDocument, readIssueThreads } from './linear-sync/document'
import type { FactoryStageComment } from './task-activity-timeline'

/** Correlate this projection with an already-authorized Task document.
 * The caller intersects the result with the messages in that document before
 * sending a source identity to a client. */
export function taskDocumentStageComments(issueId: typeof issues.id | typeof issueDocuments.issueId, workspaceId: string) {
  return sql<FactoryStageComment[]>`(
    SELECT COALESCE(json_agg(json_build_object('threadId', u."taskId", 'messageId', u."commentId")
      ORDER BY u."taskId", u."commentId"), '[]'::json)
    FROM factory_tasks t JOIN factory_stage_updates u ON u."taskId"=t.id
    WHERE t."issueId"=${issueId} AND t."workspaceId"=${workspaceId})`
}

/** The caller holds the Task ACL and supplies only visible Task IDs. Keep the
 * lookup on its already-open APP transaction and omit deleted Yjs messages. */
export async function readTaskStageComments(workspaceId: string, issueIds: string[]) {
  const comments = taskDocumentStageComments(issues.id, workspaceId)
  const rows = await db.select({ issueId: issues.id, state: issueDocuments.state, comments }).from(issues)
    .innerJoin(issueDocuments, and(eq(issueDocuments.issueId, issues.id), eq(issueDocuments.userId, issues.userId)))
    .where(and(inArray(issues.id, issueIds), eq(issues.workspaceId, workspaceId), eq(issues.ownershipState, 'bound'),
      sql`json_array_length(${comments}) > 0`))
  const byIssue = new Map<string, FactoryStageComment[]>()
  for (const { issueId, state, comments } of rows) {
    const doc = loadIssueDocument(state, {})
    try {
      const present = new Map(readIssueThreads(doc).map(thread => [thread.id, new Set(thread.messages.map(message => message.id))]))
      byIssue.set(issueId, comments.filter(({ threadId, messageId }) => present.get(threadId)?.has(messageId)))
    } finally { doc.destroy() }
  }
  return byIssue
}
