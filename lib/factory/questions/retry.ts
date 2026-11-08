import { runChanged } from '../../live/panels';
import { serverRunFailure } from '../../run-failure-details';
import type { Pool } from "pg";
import { runListChanged } from "../../live/lists";

/** Historical generic retries must not discard an ancestor's strict session fence. */
export async function blockQuestionRetry(
  db: Pick<Pool, "query">,
  userId: string,
  issueId: string,
  runId: string,
): Promise<boolean> {
  const {
    rows: [result],
  } = await db.query(
    `WITH RECURSIVE ancestors AS (
       SELECT p.id,p."retryOf",p."questionContinuation" FROM agent_runs r
       JOIN agent_runs p ON p.id=r."retryOf" AND p."userId"=$1 AND p."issueId"=$2
       WHERE r.id=$3 AND r."userId"=$1 AND r."issueId"=$2
       UNION
       SELECT p.id,p."retryOf",p."questionContinuation" FROM agent_runs p
       JOIN ancestors a ON p.id=a."retryOf"
       WHERE p."userId"=$1 AND p."issueId"=$2
     ), unsafe AS (
       SELECT EXISTS(SELECT 1 FROM ancestors WHERE "questionContinuation" IS NOT NULL) AS blocked
     ), ended AS (
       UPDATE agent_runs SET status='failed',"stopReason"='blocked',
         "failureDetails"=$4::jsonb,
         error='Generic retry cannot replay an original-session question answer; explicit recovery required.',
         "finishedAt"=now(),"updatedAt"=now()
       WHERE id=$3 AND "userId"=$1 AND "issueId"=$2 AND status='queued' AND (SELECT blocked FROM unsafe)
       RETURNING id
     ) SELECT blocked, (SELECT id FROM ended) AS "changedRunId" FROM unsafe`,
    [userId, issueId, runId, JSON.stringify(serverRunFailure(runId, new Date()))],
  );
  if (result.changedRunId) { await runListChanged(db, result.changedRunId); await runChanged(db, result.changedRunId); }
  return result.blocked;
}
