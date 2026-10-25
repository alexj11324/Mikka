import {createHash,randomUUID} from 'node:crypto'
import {test,expect} from '@playwright/test'
import {Pool} from 'pg'
import {handleGroup} from '../../lib/group-conversations-store'
import {groupDirectory} from '../../lib/group-conversations-directory'

test('generic heartbeat cannot revive expired group epochs or ordinary leases',async({request},info)=>{
 const target=new URL(process.env.E2E_DATABASE_URL!)
 expect(target.hostname).toBe('127.0.0.1');expect(target.pathname).toBe('/mikka_e2e')
 const pool=new Pool({connectionString:target.toString(),max:4})
 const owner='heartbeat-owner-'+randomUUID(),member='heartbeat-member-'+randomUUID(),outsider='heartbeat-outsider-'+randomUUID()
 const workspaceId=randomUUID(),deviceId=randomUUID(),agentId=randomUUID(),token='orv_fixture_'+randomUUID(),foreign='orv_fixture_'+randomUUID()
 const directory=groupDirectory({async activeUsers(w,ids){return(await pool.query(`SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`,[w,ids])).rows.map(r=>r.userId)},async ownedAgents(u,ids,tx){return(await(tx??pool).query('SELECT id FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])',[u,ids])).rows.map(r=>r.id)}})
 const group=(data:unknown,bearer=token)=>request.post(`/mikka/v1/devices/${deviceId}/group-reviews`,{headers:{authorization:'Bearer '+bearer},data})
 const heartbeat=(ids:string[],bearer=token)=>request.post(`/mikka/v1/devices/${deviceId}/heartbeat`,{headers:{authorization:'Bearer '+bearer},data:{harnesses:[],runs:ids.map(runId=>({runId,lastProgressAt:new Date().toISOString()})),worktreeDiskBytes:0}})
 const evidence:unknown[]=[]
 try{
  for(const u of [owner,member])await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,'Synthetic',$3,'member','active')`,[workspaceId,u,u+'@example.invalid'])
  await pool.query(`INSERT INTO devices(id,"ownerId",name,enabled) VALUES($1,$2,'Synthetic heartbeat',true)`,[deviceId,owner])
  await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,'Synthetic heartbeat','codex',$3)`,[agentId,owner,deviceId])
  for(const [u,value] of [[owner,token],[outsider,foreign]])await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,$2,$3)`,[randomUUID(),u,createHash('sha256').update(value).digest('hex')])
  for(const mode of ['expired','live','revoked']){
   const created=await handleGroup(pool,directory,{userId:owner,method:'POST',resource:'conversations',body:JSON.stringify({workspaceId,title:'Heartbeat boundary',members:[{memberType:'user',memberId:member},{memberType:'agent',memberId:agentId}]}),origin:null,host:'localhost'})
   expect(created.status).toBe(201);const conversationId=(created.body as {id:string}).id
   expect((await handleGroup(pool,directory,{userId:member,method:'POST',resource:'messages',id:conversationId,body:JSON.stringify({body:'Synthetic request',mentions:[{memberType:'agent',memberId:agentId}]}),origin:null,host:'localhost'})).status).toBe(201)
   expect((await group({action:'poll'})).status()).toBe(200)
   const work=(await pool.query('SELECT * FROM conversation_work WHERE "conversationId"=$1',[conversationId])).rows[0]
   const claimed=await group({action:'claim',runId:work.runId});expect(claimed.status()).toBe(200);const claim=await claimed.json();expect(claim.status).toBe('claimed')
   if(mode==='expired')await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`,[work.runId])
   if(mode==='revoked')await pool.query('UPDATE conversation_agent_grants SET "revokedAt"=now() WHERE id=$1',[work.grantId])
   const before=(await pool.query('SELECT "leaseExpiresAt" FROM agent_runs WHERE id=$1',[work.runId])).rows[0].leaseExpiresAt
   expect((await heartbeat([work.runId],foreign)).status()).toBe(404)
   const beat=await heartbeat([work.runId]);expect(beat.status()).toBe(200);const b=await beat.json()
   expect(b.leases[work.runId]).toBeUndefined();expect(b.revoked).toContain(work.runId)
   expect((await pool.query('SELECT "leaseExpiresAt" FROM agent_runs WHERE id=$1',[work.runId])).rows[0].leaseExpiresAt).toEqual(before)
   const check=await group({action:'check',runId:work.runId,claimEpoch:claim.claimEpoch});expect(check.status()).toBe(200);expect((await check.json()).live).toBe(mode==='live')
   const reply={workId:work.id,triggerMessageId:work.triggerMessageId,claimEpoch:claim.claimEpoch,body:'Synthetic reply; no CLI invoked'}
   if(mode==='live')expect((await group({action:'complete',runId:work.runId,reply:{...reply,claimEpoch:claim.claimEpoch+1}})).status()).toBe(409)
   const completed=await group({action:'complete',runId:work.runId,reply});expect(completed.status()).toBe(mode==='live'?200:409)
   expect((await pool.query(`SELECT count(*)::int AS n FROM conversation_messages WHERE "conversationId"=$1 AND "authorType"='agent'`,[conversationId])).rows[0].n).toBe(mode==='live'?1:0)
   if(mode==='expired'){
    const retry=await group({action:'claim',runId:work.runId});expect(retry.status()).toBe(200);expect((await retry.json()).status).toBe('uncertain')
    expect((await pool.query('SELECT "uncertainAt" FROM conversation_work WHERE id=$1',[work.id])).rows[0].uncertainAt).not.toBeNull()
    expect((await group({action:'complete',runId:work.runId,reply})).status()).toBe(409)
   }
   evidence.push({mode,genericLeaseReturned:false,dedicatedLive:mode==='live',completeStatus:completed.status(),realCLI:false})
  }
  // Ordinary attempts also may not revive expired leases or stopped work.
  const ids:Record<string,string>={}
  for(const mode of ['live','expired','stopped']){
   const id=randomUUID();ids[mode]=id
   await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId",status,"leaseExpiresAt","stopRequestedAt") VALUES($1,$2,$3,$4,'running',now()+($5::int*interval '1 second'),CASE WHEN $6 THEN now() ELSE NULL END)`,[id,owner,agentId,deviceId,mode==='expired'?-1:30,mode==='stopped'])
  }
  const beat=await heartbeat(Object.values(ids));expect(beat.status()).toBe(200);const body=await beat.json()
  expect(body.leases[ids.live]).toBeTruthy()
  for(const mode of ['expired','stopped']){expect(body.leases[ids[mode]]).toBeUndefined();expect(body.revoked).toContain(ids[mode])}
  evidence.push({ordinary:{live:'renewed',expired:'revoked',stopped:'revoked'}})
  // A valid lease can expire while renewal waits for the row. The database
  // must evaluate expiry after that wait, not use the request's old timestamp.
  const waitingId=randomUUID(),tx=await pool.connect()
  try{
   await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,'running',now()+interval '1 second')`,[waitingId,owner,agentId,deviceId])
   await tx.query('BEGIN');await tx.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[waitingId])
   const pid=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   const pending=heartbeat([waitingId]);let blocked=false
   for(let i=0;i<100&&!blocked;i++){
    blocked=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked
    if(!blocked)await new Promise(r=>setTimeout(r,20))
   }
   await new Promise(r=>setTimeout(r,1100));await tx.query('COMMIT')
   const response=await pending;expect(blocked).toBe(true);expect(response.status()).toBe(200)
   const result=await response.json();expect(result.leases[waitingId]).toBeUndefined();expect(result.revoked).toContain(waitingId)
   evidence.push({ordinaryExpiryDuringRowLock:'revoked',blocked})
  }finally{await tx.query('ROLLBACK');tx.release()}
  await info.attach('heartbeat-lease-boundary',{contentType:'application/json',body:JSON.stringify({sha:process.env.GITHUB_SHA,layer:'actual Next HTTP and isolated PG; synthetic replies; no CLI/provider',evidence})})
 }finally{await pool.end()}
})
