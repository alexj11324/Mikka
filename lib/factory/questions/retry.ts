import type { Pool } from "pg";

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
       SELECT p.id,p."retryOf",p."questionContinuation",p."ciContinuation" FROM agent_runs r
       JOIN agent_runs p ON p.id=r."retryOf" AND p."userId"=$1 AND p."issueId"=$2
       WHERE r.id=$3 AND r."userId"=$1 AND r."issueId"=$2
       UNION
       SELECT p.id,p."retryOf",p."questionContinuation",p."ciContinuation" FROM agent_runs p
       JOIN ancestors a ON p.id=a."retryOf"
       WHERE p."userId"=$1 AND p."issueId"=$2
     ), unsafe AS (
       SELECT EXISTS(SELECT 1 FROM ancestors WHERE ("questionContinuation" IS NOT NULL OR "ciContinuation" IS NOT NULL)) AS blocked
     ), ended AS (
       UPDATE agent_runs SET status='failed',"stopReason"='blocked',
         error='Generic retry cannot replay an original-session continuation; explicit recovery required.',
         "finishedAt"=now(),"updatedAt"=now()
       WHERE id=$3 AND "userId"=$1 AND "issueId"=$2 AND status='queued' AND (SELECT blocked FROM unsafe)
       RETURNING id
     ) SELECT blocked FROM unsafe`,
    [userId, issueId, runId],
  );
  return result.blocked;
}
