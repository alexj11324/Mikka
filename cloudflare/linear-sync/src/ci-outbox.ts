import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

/** A bounded delivery batch. A crash or non-2xx response leaves the same
 * durable result retryable; the app must deduplicate the watch/head pair. */
export async function deliverCiOutbox(pool:Pool, send:(item:{watchId:string;head:string;fingerprint:string},signal:AbortSignal)=>Promise<boolean>, options:{limit:number;deadline:number;now?:()=>number;random?:()=>number}):Promise<{sent:number;failed:number}> {
  const now=options.now ?? Date.now, random=options.random ?? Math.random, limit=Math.max(1,Math.min(20,Math.floor(options.limit)))
  const tx=await pool.connect()
  const leased:Array<{userId:string;issueId:string;remoteKey:string;prNumber:number;head:string;watchId:string;fingerprint:string;leaseId:string;attempts:number}>=[]
  try {
    await tx.query('BEGIN')
    const rows=await tx.query(`SELECT q."userId",q."issueId",q."remoteKey",q."prNumber",q.head,q.attempts,q.payload->>'fingerprint' AS fingerprint,o."watchId" FROM github_ci_poll_outbox q JOIN github_ci_observations o USING ("userId","issueId","remoteKey","prNumber") WHERE q."deliveredAt" IS NULL AND q."nextAttemptAt"<=now() AND (q."leaseUntil" IS NULL OR q."leaseUntil"<=now()) AND o."expiresAt">now() AND o."pollObservation"->>'head'=q.head AND o."pollObservation"->>'fingerprint'=q.payload->>'fingerprint' ORDER BY q."createdAt" FOR UPDATE OF q SKIP LOCKED LIMIT $1`,[limit])
    for (const row of rows.rows) {
      const leaseId=randomUUID()
      await tx.query(`UPDATE github_ci_poll_outbox SET "leaseId"=$6,"leaseUntil"=now()+interval '2 minutes' WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 AND head=$5`,[row.userId,row.issueId,row.remoteKey,row.prNumber,row.head,leaseId])
      leased.push({...row,leaseId})
    }
    await tx.query('COMMIT')
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  const result={sent:0,failed:0}
  for (const item of leased) {
    let ok=false
    try { const remaining=options.deadline-now(); if (remaining>0) ok=await send({watchId:item.watchId,head:item.head,fingerprint:item.fingerprint},AbortSignal.timeout(Math.min(remaining,30_000))) } catch { /* retry from durable queue */ }
    const args=[item.userId,item.issueId,item.remoteKey,item.prNumber,item.head,item.leaseId]
    const sql=ok
      ? `UPDATE github_ci_poll_outbox SET "deliveredAt"=now(),"leaseId"=NULL,"leaseUntil"=NULL WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 AND head=$5 AND "leaseId"=$6 AND "deliveredAt" IS NULL`
      : `UPDATE github_ci_poll_outbox SET attempts=least(attempts+1,8),"nextAttemptAt"=to_timestamp($7/1000.0),"leaseId"=NULL,"leaseUntil"=NULL WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 AND head=$5 AND "leaseId"=$6 AND "deliveredAt" IS NULL`
    if (ok) {
      const client=await pool.connect()
      try {
        await client.query('BEGIN')
        const updated=await client.query(sql,args)
        if (updated.rowCount) {
          await client.query(`UPDATE github_ci_observations SET "pollObservation"=jsonb_set("pollObservation",'{deliveredFingerprint}',to_jsonb($6::text)) WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 AND "pollObservation"->>'head'=$5 AND "pollObservation"->>'fingerprint'=$6`,[item.userId,item.issueId,item.remoteKey,item.prNumber,item.head,item.fingerprint])
          result.sent++
        }
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    } else {
      const delay=Math.min(3_600_000,60_000*2**Math.max(0,Math.min(6,item.attempts))) * (0.8+0.2*Math.max(0,Math.min(1,random())))
      const updated=await pool.query(sql,[...args,now()+Math.floor(delay)])
      if (updated.rowCount) result.failed++
    }
  }
  return result
}
