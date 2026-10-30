import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import type { CiPollLease } from './ci-poller'

type Issued={token:string;expiresAt:string}
function scope(lease:CiPollLease,expiresAt:string) {
  const b=lease.binding
  if(!b||!lease.token)throw Error('CI token unavailable')
  return Buffer.from(JSON.stringify(['ci-scoped-token-v1',lease.id,lease.generation,b.userId,b.issueId,b.remoteKey,b.installationId,b.repositoryId,b.githubAccountId,b.originRunId,b.scopeVersion,expiresAt]))
}
function key(secret:string) {
  if(Buffer.byteLength(secret)<32)throw Error('CI token cache unavailable')
  return Buffer.from(hkdfSync('sha256',secret,'mikka-ci-token-cache-v1','cache',32))
}
function seal(lease:CiPollLease,issued:Issued,secret:string) {
  const k=key(secret), nonce=randomBytes(12)
  try {const c=createCipheriv('aes-256-gcm',k,nonce);c.setAAD(scope(lease,issued.expiresAt));const data=Buffer.concat([c.update(issued.token,'utf8'),c.final()]);return Buffer.concat([Buffer.from([1]),nonce,c.getAuthTag(),data])} finally{k.fill(0)}
}
function open(lease:CiPollLease,expiresAt:string,blob:Buffer,secret:string) {
  if(blob.length<30 || blob.length>8192 || blob[0]!==1)throw Error('CI token unavailable')
  const k=key(secret)
  try {const c=createDecipheriv('aes-256-gcm',k,blob.subarray(1,13));c.setAAD(scope(lease,expiresAt));c.setAuthTag(blob.subarray(13,29));return Buffer.concat([c.update(blob.subarray(29)),c.final()]).toString('utf8')} finally{k.fill(0)}
}

/** Leases serialize refresh for a watch. The encrypted token is shared across
 * cold isolates, valid only for this exact owner, repository and generation. */
export async function scopedCiToken(pool:Pool,lease:CiPollLease,secret:string,issue:(lease:CiPollLease)=>Promise<Issued>,now=Date.now()):Promise<string> {
  const b=lease.binding
  if(!b||!lease.token)throw Error('CI token unavailable')
  const params=[b.userId,b.issueId,b.remoteKey,b.prNumber,lease.id,lease.token,lease.generation]
  const where='"userId"=$1 AND "issueId"=$2 AND "remoteKey"=$3 AND "prNumber"=$4 AND "watchId"=$5 AND "pollLeaseId"=$6 AND generation=$7::bigint AND "pollLeaseUntil">now() AND "expiresAt">now()'
  const cached=await pool.query(`SELECT "pollTokenEnvelope","pollTokenExpiresAt" FROM github_ci_observations WHERE ${where}`,params)
  if(!cached.rowCount)throw Error('CI token unavailable')
  const row=cached.rows[0]
  if(row.pollTokenEnvelope && row.pollTokenExpiresAt instanceof Date && row.pollTokenExpiresAt.getTime()>now+5*60_000) {
    try {const token=open(lease,row.pollTokenExpiresAt.toISOString(),row.pollTokenEnvelope,secret);if(token && token.length<=4096)return token} catch { /* fetch an authorized replacement */ }
  }
  const issued=await issue(lease), expires=new Date(issued.expiresAt)
  if(typeof issued.token!=='string'||!issued.token||issued.token.length>4096||!Number.isFinite(expires.getTime())||expires.getTime()<=now+5*60_000||expires.getTime()>now+65*60_000)throw Error('CI token unavailable')
  const normalized={token:issued.token,expiresAt:expires.toISOString()}
  const envelope=seal(lease,normalized,secret)
  const saved=await pool.query(`UPDATE github_ci_observations SET "pollTokenEnvelope"=$8,"pollTokenExpiresAt"=$9 WHERE ${where} RETURNING "watchId"`,[...params,envelope,expires])
  if(!saved.rowCount)throw Error('CI token unavailable')
  return issued.token
}
