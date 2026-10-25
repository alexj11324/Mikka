import {createHash,randomUUID} from 'node:crypto'
import {test,expect} from '@playwright/test'
import {Pool} from 'pg'
import {handleGroup} from '../../lib/group-conversations-store'
import {groupDirectory} from '../../lib/group-conversations-directory'

test('dedicated group HTTP admits persisted issue-less assignment but never generic MCP',async({request},testInfo)=>{
 const target=new URL(process.env.E2E_DATABASE_URL!);expect(['localhost','127.0.0.1']).toContain(target.hostname);expect(target.pathname).toBe('/mikka_e2e')
 const pool=new Pool({connectionString:target.toString()}),owner='group-owner-'+randomUUID(),member='group-member-'+randomUUID(),outsider='group-outsider-'+randomUUID()
 const workspaceId=randomUUID(),agentId=randomUUID(),deviceId=randomUUID(),tokenId=randomUUID(),token='orv_fixture_'+randomUUID(),other='orv_fixture_'+randomUUID()
 const directory=groupDirectory({async activeUsers(w,ids){return(await pool.query(`SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`,[w,ids])).rows.map(r=>r.userId)},async ownedAgents(u,ids,client){return(await(client??pool).query('SELECT id FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])',[u,ids])).rows.map(r=>r.id)}})
 const url=`/mikka/v1/devices/${deviceId}/group-reviews`
 const call=(data:unknown,bearer=token)=>request.post(url,{headers:{authorization:'Bearer '+bearer},data})
 try{
  for(const u of [owner,member])await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,'Fixture',$3,'member','active')`,[workspaceId,u,u+'@example.invalid'])
  await pool.query(`INSERT INTO devices(id,"ownerId",name,enabled) VALUES($1,$2,'fixture',true)`,[deviceId,owner])
  await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,'fixture','codex',$3)`,[agentId,owner,deviceId])
  for(const [id,u,value] of [[tokenId,owner,token],[randomUUID(),outsider,other]])await pool.query(`INSERT INTO device_tokens(id,"userId",name,"tokenHash") VALUES($1,$2,'fixture',$3)`,[id,u,createHash('sha256').update(value).digest('hex')])
  const created=await handleGroup(pool,directory,{userId:owner,method:'POST',resource:'conversations',body:JSON.stringify({workspaceId,title:'HTTP fixture',members:[{memberType:'user',memberId:member},{memberType:'agent',memberId:agentId}]}),origin:null,host:'localhost'});expect(created.status).toBe(201)
  const conversationId=(created.body as {id:string}).id
  expect((await handleGroup(pool,directory,{userId:member,method:'POST',resource:'messages',id:conversationId,body:JSON.stringify({body:'Fixture only',mentions:[{memberType:'agent',memberId:agentId}]}),origin:null,host:'localhost'})).status).toBe(201)
  expect((await call({action:'poll'},'invalid')).status()).toBe(401)
  expect((await call({action:'poll'},other)).status()).toBe(404)
  expect((await call({action:'poll'})).status()).toBe(200)
  const work=(await pool.query('SELECT * FROM conversation_work WHERE "conversationId"=$1',[conversationId])).rows[0]
  const claiming=await call({action:'claim',runId:work.runId});expect(claiming.status()).toBe(200);const claim=await claiming.json();expect(claim.status).toBe('claimed')
  const runtimeToken='mkw_fixture_'+randomUUID()
  await pool.query(`INSERT INTO run_tokens(id,"runId","userId","tokenHash","expiresAt") VALUES($1,$2,$3,$4,now()+interval '1 hour')`,[randomUUID(),work.runId,owner,createHash('sha256').update(runtimeToken).digest('hex')])
  for(const name of ['report','ask','blocked'])expect((await request.post('/mikka/api/mcp',{headers:{authorization:'Bearer '+runtimeToken,accept:'application/json, text/event-stream'},data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{text:'Fixture'}}}})).status()).toBe(401)
  const completion={action:'complete',runId:work.runId,reply:{workId:work.id,triggerMessageId:work.triggerMessageId,claimEpoch:claim.claimEpoch,body:'Controlled HTTP reply'}}
  const completed=await call(completion);expect(completed.status()).toBe(200);expect((await completed.json()).status).toBe('completed')
  expect((await pool.query(`SELECT count(*) FROM conversation_messages WHERE "conversationId"=$1 AND "authorType"='agent'`,[conversationId])).rows[0].count).toBe('1')
  await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspaceId,member])
  expect((await call(completion)).status()).toBe(404)
  await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1',[tokenId]);expect((await call(completion)).status()).toBe(401)
  await testInfo.attach('group-authority-evidence',{body:JSON.stringify({sha:process.env.GITHUB_SHA,environment:'isolated local PG + actual built Next HTTP',conversationId,runId:work.runId,checks:['claim','reply','generic MCP denied','nonowner denied','suspension replay denied','revoked token denied']}),contentType:'application/json'})
 }finally{await pool.end()}
})
