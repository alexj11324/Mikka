import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { recordCiAttention, type CiNoticeIdentity } from './notice'

/** Consume failures via the already scheduled briefing request. No CI polling
 * request is sent to the app for intermediate check states. */
export async function notifyPollFailures(pool:Pool,deadline:number,wake:(userId:string)=>Promise<void>) {
  const result={attempted:0,failed:0}
  const leaseId=randomUUID()
  const acquired=await pool.query(`INSERT INTO github_ci_attention_cursor (id,"leaseId","leaseUntil") VALUES (true,$1,now()+interval '2 minutes') ON CONFLICT(id) DO UPDATE SET "leaseId"=EXCLUDED."leaseId","leaseUntil"=EXCLUDED."leaseUntil" WHERE github_ci_attention_cursor."leaseUntil" IS NULL OR github_ci_attention_cursor."leaseUntil"<=now() RETURNING "watchId",kind`,[leaseId])
  if(!acquired.rowCount)return result
  const cursor=acquired.rows[0]
  try {
  const {rows}=await pool.query<CiNoticeIdentity & {failureKind:'poll'|'delivery'}>(`SELECT o."userId",o."issueId",o."remoteKey",o."prNumber",o."originRunId",o."scopeVersion",o.generation,o."watchId",f.kind AS "failureKind"
    FROM github_ci_observations o CROSS JOIN LATERAL (VALUES ('poll'),('delivery')) f(kind)
    WHERE o."expiresAt">now() AND ((f.kind='poll' AND o."pendingReason" IS NOT NULL AND o."pendingReasonSince"<=now()-interval '15 minutes') OR (f.kind='delivery' AND EXISTS (SELECT 1 FROM github_ci_poll_outbox q WHERE q."userId"=o."userId" AND q."issueId"=o."issueId" AND q."remoteKey"=o."remoteKey" AND q."prNumber"=o."prNumber" AND q."originRunId"=o."originRunId" AND q.generation=o.generation AND q."deliveredAt" IS NULL AND q.head=o."pollObservation"->>'head' AND q.payload->>'fingerprint'=o."pollObservation"->>'fingerprint' AND q.attempts>=2 AND q."createdAt"<=now()-interval '15 minutes')))
    AND ($1::uuid IS NULL OR (o."watchId",f.kind)>($1::uuid,$2::text))
    AND NOT EXISTS (SELECT 1 FROM coordinator_events e WHERE e."dedupeKey"=concat('ci-poll-attention:',o."watchId",':',o.generation,':',f.kind) AND e."deliveredAt" IS NOT NULL)
    ORDER BY o."watchId",f.kind LIMIT 20`,[cursor?.watchId ?? null,cursor?.kind ?? null])
  for(const row of rows){
    if(Date.now()>=deadline)break
    result.attempted++
    // Advance even when a candidate is revoked or locked, so another user's
    // notice is not starved by an indefinitely unprocessable prefix.
    const advanced=await pool.query(`UPDATE github_ci_attention_cursor SET "watchId"=$2,kind=$3 WHERE id=true AND "leaseId"=$1 AND "leaseUntil">now() RETURNING id`,[leaseId,row.watchId,row.failureKind])
    if(!advanced.rowCount)throw new Error('CI attention lease lost')
    try {
      const key=`ci-poll-attention:${row.watchId}:${row.generation}:${row.failureKind}`
      if(await recordCiAttention(pool,row,key,'CI results could not be verified for this pull request. Please review its checks on GitHub.'))await wake(row.userId)
    } catch { result.failed++ }
  }
  if(!rows.length)await pool.query('UPDATE github_ci_attention_cursor SET "watchId"=NULL,kind=NULL WHERE id=true AND "leaseId"=$1',[leaseId])
  return result
  } finally {await pool.query('UPDATE github_ci_attention_cursor SET "leaseId"=NULL,"leaseUntil"=NULL WHERE id=true AND "leaseId"=$1',[leaseId]).catch(()=>{})}
}
