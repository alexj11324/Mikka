import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { loadIssueDocument, readIssueThreads } from './linear-sync/document'
import type { FactoryStageComment } from './task-activity-timeline'

/** The caller admits the Tasks. A reader of the shared document can already
 * see its discussion identities. Never expose stage receipts for a deleted
 * message, a different Task, or another workspace. */
export async function readTaskStageComments(db: Pick<Pool | PoolClient, 'query'>, workspaceId: string, issueIds: string[]) {
  const { rows } = await db.query<{ issueId: string; state: string; comments: FactoryStageComment[] }>(`
    SELECT i.id AS "issueId", d.state, stages.comments
    FROM issues i JOIN issue_documents d ON d."issueId"=i.id AND d."userId"=i."userId"
    JOIN LATERAL (
      SELECT json_agg(json_build_object('threadId', u."taskId", 'messageId', u."commentId")
        ORDER BY u."taskId", u."commentId") AS comments
      FROM factory_tasks t JOIN factory_stage_updates u ON u."taskId"=t.id
      WHERE t."issueId"=i.id AND t."workspaceId"=i."workspaceId"
    ) stages ON stages.comments IS NOT NULL
    WHERE i."workspaceId"=$1 AND i.id=ANY($2::uuid[]) AND length(d.state)>0 AND i."ownershipState"='bound'`, [workspaceId, issueIds])
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
