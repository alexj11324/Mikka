import type { Pool } from 'pg'
import type { CiPollLease } from './ci-poller'

/** Branch rules are cached briefly; the final application claim always reads
 * fresh provider state. A changed target branch has a different cache key. */
export function staticCiCache(pool:Pool,lease:CiPollLease) {
  const b=lease.binding;if(!b||!lease.token)throw Error('CI lease unavailable')
  const params=[b.userId,b.issueId,b.remoteKey,b.prNumber,lease.id,lease.token,lease.generation]
  const where='"userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 AND "watchId"=$5 AND "pollLeaseId"=$6 AND generation=$7::bigint AND "pollLeaseUntil">now() AND "expiresAt">now()'
  return {
    async get(key:string) {
      const result=await pool.query(`SELECT "pollRules" FROM github_ci_observations WHERE ${where}`,params)
      if(!result.rowCount)throw Error('CI lease lost')
      const v=result.rows[0].pollRules
      if(!v||v.key!==key||!Number.isFinite(v.expiresAt)||v.expiresAt<=Date.now()||!Array.isArray(v.rules)||v.rules.length>5)return null
      return {branch:v.branch,rules:v.rules as unknown[][]}
    },
    async put(key:string,value:{branch:unknown;rules:unknown[][]}) {
      const encoded=JSON.stringify({key,expiresAt:Date.now()+30*60_000,...value})
      if(Buffer.byteLength(encoded)>65536)return
      const result=await pool.query(`UPDATE github_ci_observations SET "pollRules"=$8::jsonb WHERE ${where} RETURNING "watchId"`,[...params,encoded])
      if(!result.rowCount)throw Error('CI lease lost')
    },
  }
}
