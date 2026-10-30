import { z } from 'zod'
import { pool } from '@/lib/db'
import { verifyBearer } from '@/lib/linear-sync/webhook'
import { acquireCiMembership, ciIssueAuthorized } from '@/lib/github/ci/authority'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { verifyGitHubRepositoryAccess } from '@/lib/github/run-pull-request'
import { githubAppJwt } from '@/lib/suggestions/github-redelivery'

export const runtime='nodejs'
const input=z.object({watchId:z.uuid(),leaseId:z.uuid(),generation:z.string().regex(/^\d{1,20}$/)}).strict()
const headers={'cache-control':'private, no-store'}
const query=`SELECT o."userId",o."issueId",o."remoteKey",o."prNumber",o."scopeVersion",o."originRunId",i."userId" AS "issueOwner",i.scope,i.content,i."scopeVersion" AS "currentScopeVersion",gi."installationId",gi."repositoryId",gi."githubAccountId",p.branch FROM github_ci_observations o JOIN issues i ON i.id=o."issueId" JOIN github_repository_installations gi ON gi."userId"=o."userId" AND gi."remoteKey"=o."remoteKey" JOIN run_publications p ON p."runId"=o."originRunId" AND p."userId"=o."userId" AND p."issueId"=o."issueId" AND p."remoteKey"=o."remoteKey" AND p.status='published' JOIN LATERAL (SELECT a."accountId" FROM account a WHERE a."userId"=o."userId" AND a."providerId"='github' ORDER BY a."createdAt" LIMIT 1) linked ON linked."accountId"=gi."githubAccountId" WHERE o."watchId"=$1 AND o."pollLeaseId"=$2 AND o.generation=$3::bigint AND o."pollLeaseUntil">now() AND o."expiresAt">now()`

/** Issues one short-lived, repository-scoped read token only for a current
 * worker lease. The private App key never leaves this application process. */
export async function POST(request:Request) {
  if(!process.env.CRON_SECRET || !await verifyBearer(request.headers.get('authorization'),process.env.CRON_SECRET))return new Response(null,{status:401,headers})
  const reader=request.body?.getReader();if(!reader)return new Response(null,{status:400,headers})
  const parts:Uint8Array[]=[];let length=0
  try{for(;;){const n=await reader.read();if(n.done)break;length+=n.value.length;if(length>512){await reader.cancel();return new Response(null,{status:413,headers})}parts.push(n.value)}}finally{reader.releaseLock()}
  let value:unknown;try{value=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{return new Response(null,{status:400,headers})}
  const parsed=input.safeParse(value);if(!parsed.success)return new Response(null,{status:400,headers})
  const args=[parsed.data.watchId,parsed.data.leaseId,parsed.data.generation]
  let membership:Awaited<ReturnType<typeof acquireCiMembership>>|undefined
  try {
    const hints=await pool.query(query,args);if(hints.rowCount!==1)throw Error()
    const h=hints.rows[0]
    membership=await acquireCiMembership(h.issueId,h.userId,h.issueOwner,undefined,h.scope==='workspace')
    if(!ciIssueAuthorized({userId:h.issueOwner,scope:h.scope,scopeVersion:h.currentScopeVersion,content:h.content},h.userId,h.scopeVersion,membership.held,v=>Boolean(readIssueMetadata(v as never).deletedAt)))throw Error()
    const access=await verifyGitHubRepositoryAccess({remoteKey:h.remoteKey,githubAccountId:h.githubAccountId})
    if(access.installationId!==Number(h.installationId)||access.repositoryId!==Number(h.repositoryId))throw Error()
    const jwt=githubAppJwt(process.env.GITHUB_APP_ID!,process.env.GITHUB_APP_PRIVATE_KEY!)
    const response=await fetch(`https://api.github.com/app/installations/${access.installationId}/access_tokens`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${jwt}`,accept:'application/vnd.github+json','content-type':'application/json','x-github-api-version':'2022-11-28'},body:JSON.stringify({repository_ids:[access.repositoryId],permissions:{metadata:'read',pull_requests:'read',checks:'read',statuses:'read',contents:'read',actions:'read'}}),signal:AbortSignal.timeout(8000)})
    if(!response.ok)throw Error()
    const token=z.object({token:z.string().min(1).max(4096),expires_at:z.iso.datetime()}).parse(await response.json())
    const expiry=Date.parse(token.expires_at);if(expiry<=Date.now()+300000||expiry>Date.now()+65*60000)throw Error()
    await membership.check()
    const client=await pool.connect()
    try {
      await client.query('BEGIN')
      const current=await client.query(`${query} FOR UPDATE OF o,i`,args)
      if(current.rowCount!==1)throw Error()
      const r=current.rows[0]
      if(r.originRunId!==h.originRunId||r.scopeVersion!==h.scopeVersion||r.issueOwner!==h.issueOwner||r.scope!==h.scope||r.installationId!==h.installationId||r.repositoryId!==h.repositoryId||r.githubAccountId!==h.githubAccountId||r.branch!==h.branch||!ciIssueAuthorized({userId:r.issueOwner,scope:r.scope,scopeVersion:r.currentScopeVersion,content:r.content},r.userId,r.scopeVersion,membership.held,v=>Boolean(readIssueMetadata(v as never).deletedAt)))throw Error()
      await membership.check();await client.query('COMMIT');await membership.check()
      return Response.json({token:token.token,expiresAt:token.expires_at},{headers})
    } catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  } catch {return Response.json({error:'ci_token_unavailable'},{status:409,headers})} finally {await membership?.close()}
}
