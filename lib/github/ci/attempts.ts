/** Bounded set of workflow attempts associated with the current PR head. */
export type WorkflowAttempt = { runId: string; attempt: number; state: 'requested' | 'in_progress' | 'completed' }
export async function listCiWorkflowAttempts(db: { query: (sql: string, params: unknown[]) => Promise<{ rows: WorkflowAttempt[] }> }, key: { userId: string; issueId: string; remoteKey: string; prNumber: number; head: string }): Promise<WorkflowAttempt[]> {
  const { rows } = await db.query(`SELECT "runId",attempt,state FROM github_ci_workflow_attempts
    WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 AND head=$5 ORDER BY "runId" LIMIT 201`, [key.userId,key.issueId,key.remoteKey,key.prNumber,key.head])
  if (rows.length > 200 || rows.some(row => !/^[1-9][0-9]*$/.test(row.runId) || !Number.isSafeInteger(row.attempt) || row.attempt < 1 || !['requested','in_progress','completed'].includes(row.state))) throw new Error('CI workflow attempt limit or invalid receipt')
  return rows
}
