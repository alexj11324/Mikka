import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { Observation } from '../../../lib/github/ci/observation'
import type { CiPollAdapter, CiPollLease, CiPollResult, CiPollState } from './ci-poller'

/** Durable polling queue. The caller supplies a repository-scoped provider
 * reader; this layer never receives a long-lived GitHub App private key. */
export function postgresCiPollAdapter(pool: Pool, read: (lease:CiPollLease,signal:AbortSignal)=>Promise<CiPollState>, authorize: CiPollAdapter['authorize']): CiPollAdapter {
  async function transaction<T>(work:(tx:PoolClient)=>Promise<T>):Promise<T> {
    const tx=await pool.connect()
    try { await tx.query('BEGIN'); const result=await work(tx); await tx.query('COMMIT'); return result }
    catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  }
  function params(lease:CiPollLease) {
    if (!lease.token || !lease.binding) throw new Error('CI lease unavailable')
    return [lease.binding.userId,lease.binding.issueId,lease.binding.remoteKey,lease.binding.prNumber,lease.id,lease.token,lease.generation]
  }
  const predicate = `"userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 AND "watchId"=$5 AND "pollLeaseId"=$6 AND generation=$7::bigint AND "pollLeaseUntil">now() AND "expiresAt">now()`
  async function update(lease:CiPollLease,sql:string,extra:unknown[] = []) {
    const result=await pool.query(`${sql} WHERE ${predicate} RETURNING "watchId"`,[...params(lease),...extra])
    if (result.rowCount !== 1) throw new Error('CI lease lost')
  }
  return {
    read, authorize,
    async lease(limit, now) {
      return transaction(async tx => {
        const rows=await tx.query(`SELECT o.*,gi."installationId",gi."repositoryId",gi."githubAccountId",p.branch,i."userId" AS "issueOwner",i.scope AS "issueScope" FROM github_ci_observations o
          JOIN github_repository_installations gi ON gi."userId"=o."userId" AND gi."remoteKey"=o."remoteKey"
          JOIN LATERAL (SELECT a."accountId" FROM account a WHERE a."userId"=o."userId" AND a."providerId"='github' ORDER BY a."createdAt" LIMIT 1) linked ON linked."accountId"=gi."githubAccountId"
          JOIN run_publications p ON p."runId"=o."originRunId" AND p."userId"=o."userId" AND p."issueId"=o."issueId" AND p."remoteKey"=o."remoteKey" AND p.status='published'
          JOIN issues i ON i.id=o."issueId" AND i."scopeVersion"=o."scopeVersion" AND (i."userId"=o."userId" OR i.scope='workspace')
          WHERE o."nextCheckAt"<=to_timestamp($1/1000.0) AND o."expiresAt">now() AND (o."pollLeaseUntil" IS NULL OR o."pollLeaseUntil"<=now())
            AND coalesce(i.content #>> '{attrs,mikka,deletedAt}',i.content #>> '{attrs,orvilo,deletedAt}','')=''
          ORDER BY o."nextCheckAt",o."watchId" FOR UPDATE OF o SKIP LOCKED LIMIT $2`,[now,limit])
        const leases:CiPollLease[]=[]
        for (const r of rows.rows) {
          const token=randomUUID()
          await tx.query(`UPDATE github_ci_observations SET "pollLeaseId"=$5,"pollLeaseUntil"=now()+interval '2 minutes' WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4`,[r.userId,r.issueId,r.remoteKey,r.prNumber,token])
          const o=r.pollObservation as Observation | null
          const observation=o && typeof o.head==='string' && (o.fingerprint===null||typeof o.fingerprint==='string') && typeof o.firstSeenAt==='number' && (o.deliveredFingerprint===null||typeof o.deliveredFingerprint==='string') ? o : null
          leases.push({id:r.watchId,generation:String(r.generation),attempt:r.pollAttempt,observation,token,binding:{userId:r.userId,issueId:r.issueId,remoteKey:r.remoteKey,prNumber:r.prNumber,installationId:Number(r.installationId),repositoryId:Number(r.repositoryId),githubAccountId:r.githubAccountId,branch:r.branch,originRunId:r.originRunId,scopeVersion:r.scopeVersion,issueOwner:r.issueOwner,issueScope:r.issueScope}})
        }
        return leases
      })
    },
    async pending(lease,state,nextAt) {
      await update(lease,`UPDATE github_ci_observations SET "pollObservation"=$8::jsonb,"nextCheckAt"=to_timestamp($9/1000.0),"pollAttempt"=0,"pollLeaseId"=NULL,"pollLeaseUntil"=NULL`,[JSON.stringify(state),nextAt])
    },
    async close(lease) {
      await update(lease,`UPDATE github_ci_observations SET "expiresAt"=now(),"pollLeaseId"=NULL,"pollLeaseUntil"=NULL`)
    },
    async retry(lease,nextAt) {
      await update(lease,`UPDATE github_ci_observations SET "nextCheckAt"=to_timestamp($8/1000.0),"pollAttempt"=least("pollAttempt"+1,8),"pollLeaseId"=NULL,"pollLeaseUntil"=NULL`,[nextAt])
    },
    async complete(lease,state,result:CiPollResult) {
      await transaction(async tx => {
        const p=params(lease)
        const b=lease.binding!
        const issue=await tx.query(`SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2 AND scope=$3 AND "scopeVersion"=$4 AND coalesce(content #>> '{attrs,mikka,deletedAt}',content #>> '{attrs,orvilo,deletedAt}','')='' FOR UPDATE`,[b.issueId,b.issueOwner,b.issueScope,b.scopeVersion])
        if(issue.rowCount!==1)throw new Error('CI issue changed')
        const locked=await tx.query(`SELECT 1 FROM github_ci_observations WHERE ${predicate} AND "originRunId"=$8 AND "scopeVersion"=$9 AND EXISTS (SELECT 1 FROM github_repository_installations gi WHERE gi."userId"=$1 AND gi."remoteKey"=$3 AND gi."installationId"=$10 AND gi."repositoryId"=$11 AND gi."githubAccountId"=$12) AND EXISTS (SELECT 1 FROM run_publications p WHERE p."runId"=$8 AND p."userId"=$1 AND p."issueId"=$2 AND p."remoteKey"=$3 AND p.status='published' AND p.branch=$13) FOR UPDATE`,[...p,b.originRunId,b.scopeVersion,b.installationId,b.repositoryId,b.githubAccountId,b.branch])
        if (locked.rowCount !== 1) throw new Error('CI lease lost')
        await tx.query(`INSERT INTO github_ci_poll_outbox ("userId","issueId","remoteKey","prNumber",head,payload,"originRunId","scopeVersion",generation) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
          ON CONFLICT ("userId","issueId","remoteKey","prNumber",head) DO UPDATE SET payload=EXCLUDED.payload,"originRunId"=EXCLUDED."originRunId","scopeVersion"=EXCLUDED."scopeVersion",generation=EXCLUDED.generation,"leaseId"=NULL,"leaseUntil"=NULL,"nextAttemptAt"=now()
          WHERE github_ci_poll_outbox."deliveredAt" IS NULL AND (github_ci_poll_outbox.payload IS DISTINCT FROM EXCLUDED.payload OR github_ci_poll_outbox."originRunId" IS DISTINCT FROM EXCLUDED."originRunId" OR github_ci_poll_outbox."scopeVersion" IS DISTINCT FROM EXCLUDED."scopeVersion" OR github_ci_poll_outbox.generation IS DISTINCT FROM EXCLUDED.generation)`,[...p.slice(0,4),result.head,JSON.stringify(result),b.originRunId,b.scopeVersion,lease.generation])
        const prior=await tx.query(`SELECT "deliveredAt" FROM github_ci_poll_outbox WHERE "userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 AND head=$5`,[...p.slice(0,4),result.head])
        // Enqueue is not delivery. The outbox records delivery only after the
        // application has revalidated and accepted the final result.
        await tx.query(`UPDATE github_ci_observations SET "pollObservation"=$8::jsonb,"nextCheckAt"=now()+interval '15 minutes',"pollAttempt"=0,"pollLeaseId"=NULL,"pollLeaseUntil"=NULL WHERE ${predicate}`,[...p,JSON.stringify(prior.rows[0]?.deliveredAt ? {...state,deliveredFingerprint:result.fingerprint} : state)])
      })
    },
  }
}
