import type { PoolClient } from 'pg'

/** Called under the existing issue/observation locks in the final response
 * transaction. Retrying the same run is allowed; another run for that commit
 * is not. A failed transaction never consumes the claim. */
export async function claimCiCommitOnce(tx: PoolClient, input: {userId:string; issueId:string; remoteKey:string; prNumber:number; head:string; runId:string}): Promise<boolean> {
  const result = await tx.query(`INSERT INTO github_ci_commit_claims ("userId","issueId","remoteKey","prNumber",head,"runId") VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT ("userId","issueId","remoteKey","prNumber",head) DO UPDATE SET "runId"=EXCLUDED."runId"
    WHERE github_ci_commit_claims."runId"=EXCLUDED."runId" RETURNING "runId"`,
  [input.userId,input.issueId,input.remoteKey,input.prNumber,input.head.toLowerCase(),input.runId])
  return result.rowCount === 1
}
