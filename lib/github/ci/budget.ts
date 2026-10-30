/** The only dedupe and the only cap for automatic CI resumes. Each resume is
 * one row in github_ci_resumes keyed by (task, PR, head SHA): a head resumes the
 * task's session at most once, whatever its later reruns report, and a task
 * gets at most CI_RESUMES_PER_TASK_PER_DAY resumes in any rolling 24 hours. A
 * follow-up retired before any device claims it deletes its row (no model call
 * was spent), so the newest result for that head can take its place. Callers
 * hold the task's issue row lock, which serializes the count check. */
export const CI_RESUMES_PER_TASK_PER_DAY = 3

export type CiResumeKey = { userId: string; issueId: string; remoteKey: string; prNumber: number; head: string }
export type CiResumeBudget = 'reserved' | 'duplicate' | 'capped'
type Query = { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> }

export async function reserveCiResume(tx: Query, key: CiResumeKey, cap = CI_RESUMES_PER_TASK_PER_DAY): Promise<CiResumeBudget> {
  const params = [key.userId, key.issueId, key.remoteKey, key.prNumber, key.head]
  const existing = await tx.query(`SELECT 1 FROM github_ci_resumes WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 AND head=$5`, params)
  if (existing.rowCount) return 'duplicate'
  const inserted = await tx.query(`INSERT INTO github_ci_resumes ("userId","issueId","remoteKey","prNumber",head)
    SELECT $1,$2,$3,$4,$5 WHERE (SELECT count(*) FROM github_ci_resumes WHERE "userId"=$1 AND "issueId"=$2 AND "createdAt">now()-interval '24 hours') < $6
    ON CONFLICT DO NOTHING RETURNING 1`, [...params, cap])
  return inserted.rowCount ? 'reserved' : 'capped'
}

/** Ties the reservation to its queued follow-up so retirement can release it. */
export async function bindCiResume(tx: Query, key: CiResumeKey, runId: string) {
  await tx.query(`UPDATE github_ci_resumes SET "runId"=$6 WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 AND head=$5`, [key.userId, key.issueId, key.remoteKey, key.prNumber, key.head, runId])
}
