import { z } from 'zod'
import { pool } from '@/lib/db'
import { verifyBearer } from '@/lib/linear-sync/webhook'

export const runtime = 'nodejs'
const input=z.object({watchId:z.uuid(),head:z.string().regex(/^[a-f0-9]{40}$/),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict()

/** The background poller wakes this only for a persisted complete result. The
 * app still re-reads GitHub and rechecks task authority before Agent claim. */
export async function POST(request:Request) {
  if (!process.env.CRON_SECRET || !await verifyBearer(request.headers.get('authorization'),process.env.CRON_SECRET)) return new Response(null,{status:401})
  if (!request.headers.get('content-type')?.startsWith('application/json')) return new Response(null,{status:415})
  const reader=request.body?.getReader()
  if (!reader) return new Response(null,{status:400})
  const chunks:Uint8Array[]=[]; let length=0
  try {
    for (;;) {
      const next=await reader.read(); if (next.done) break
      length+=next.value.length
      if (length>512) { await reader.cancel(); return new Response(null,{status:413}) }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const raw=Buffer.concat(chunks).toString('utf8')
  let body:unknown
  try { body=JSON.parse(raw) } catch { return new Response(null,{status:400}) }
  const parsed=input.safeParse(body)
  if (!parsed.success) return new Response(null,{status:400})
  const {watchId,head,fingerprint}=parsed.data
  const updated=await pool.query(`UPDATE github_ci_observations o SET "nextCheckAt"=least(o."nextCheckAt",now()),head=$2,fingerprint=$3,"firstSeenAt"=to_timestamp((o."pollObservation"->>'firstSeenAt')::double precision/1000),"deliveredFingerprint"=CASE WHEN o.head=$2 THEN o."deliveredFingerprint" ELSE NULL END,"updatedAt"=now() FROM github_ci_poll_outbox q WHERE o."watchId"=$1 AND o."expiresAt">now() AND o."pollObservation"->>'head'=$2 AND o."pollObservation"->>'fingerprint'=$3 AND q."userId"=o."userId" AND q."issueId"=o."issueId" AND q."remoteKey"=o."remoteKey" AND q."prNumber"=o."prNumber" AND q.head=$2 AND q.payload->>'fingerprint'=$3 AND q."originRunId"=o."originRunId" AND q."scopeVersion"=o."scopeVersion" AND q.generation=o.generation RETURNING o."watchId"`,[watchId,head,fingerprint])
  if (!updated.rowCount) return new Response(null,{status:409})
  try {
    const result=await (await import('@/lib/github/ci/reconcile')).reconcileCi({pool,deadline:Date.now()+30_000,limit:1,watchId})
    if (result.failed) return new Response(null,{status:503,headers:{'cache-control':'no-store'}})
    if (!result.queued && !result.escalated && !result.closed) {
      // Lost HTTP responses may cause a retry after a durable queue/claim.
      const accepted=await pool.query(`SELECT 1 FROM github_ci_observations o WHERE o."watchId"=$1 AND o.head=$2 AND (o."deliveredFingerprint"=$3 OR EXISTS (SELECT 1 FROM github_ci_commit_claims c WHERE c."userId"=o."userId" AND c."issueId"=o."issueId" AND c."remoteKey"=o."remoteKey" AND c."prNumber"=o."prNumber" AND c.head=$2))`,[watchId,head,fingerprint])
      if (!accepted.rowCount) return new Response(null,{status:503,headers:{'cache-control':'no-store'}})
    }
    return new Response(null,{status:202,headers:{'cache-control':'no-store'}})
  } catch { return new Response(null,{status:503,headers:{'cache-control':'no-store'}}) }
}
