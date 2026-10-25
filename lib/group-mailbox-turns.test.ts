import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,readdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import test from 'node:test'
import {Pool} from 'pg'
import {orderMigrations} from '../scripts/migration-order.mjs'
import {handleGroup} from './group-conversations-store'
import {groupDirectory} from './group-conversations-directory'
import {groupReviewCommand} from './group-review-commands'
import {handleGroupWorkerRequest} from './group-worker-route'

const url=process.env.MIKKA_DISPOSABLE_POSTGRES_URL
if(url){const u=new URL(url);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.pathname,'/mikka_review');assert.equal(u.search,'')}
test('single durable group executor: concurrency, replay, rounds and uncertainty',{skip:!url},async t=>{
 const schema='rounds_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:12})
 const workspace=randomUUID(),otherWorkspace=randomUUID(),device=randomUUID(),a=randomUUID(),b=randomUUID()
 const directory=groupDirectory({async activeUsers(w,ids){return(await pool.query('SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status=\'active\'',[w,ids])).rows.map(r=>r.userId)},async ownedAgents(u,ids,c){return(await(c??pool).query('SELECT id FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])',[u,ids])).rows.map(r=>r.id)}})
 const server=createServer(async(req,res)=>{
  try{const parts=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts).toString()),user=req.headers['x-fixture-user'] as string
   if(!['owner','member','outsider'].includes(user)){res.writeHead(401);res.end('{}');return}
   let result
   if(req.url==='/worker'){
    const response=await handleGroupWorkerRequest(new Request('http://localhost/worker',{method:'POST',body:JSON.stringify(body)}),device,{pool,directory,authenticate:async()=>({userId:user})})
    if(req.headers['x-drop-response']==='yes'){req.socket.destroy();return}
    res.writeHead(response.status);res.end(await response.text());return
   }else if(req.url==='/review')result=await groupReviewCommand(pool,directory,body.group,user,body.command)
   else{const response=await handleGroup(pool,directory,{...body,userId:user,origin:null,host:'localhost'});res.writeHead(response.status);res.end(JSON.stringify(response.body));return}
   res.end(JSON.stringify(result))
  }catch(e){res.writeHead((e as {status?:number}).status??500);res.end(JSON.stringify({error:(e as Error).message}))}
 })
 let origin=''
 const call=async(path:string,body:unknown,user='owner')=>{const r=await fetch(origin+path,{method:'POST',headers:{'x-fixture-user':user,'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()}}
 const worker=(body:unknown,user='owner')=>call('/worker',body,user)
 const review=(group:string,command:unknown,user='owner')=>call('/review',{group,command},user)
 const group=async()=>{const r=await call('/group',{method:'POST',resource:'conversations',body:JSON.stringify({workspaceId:workspace,title:'fixture',members:[{memberType:'user',memberId:'member'},{memberType:'agent',memberId:a},{memberType:'agent',memberId:b}]})});assert.equal(r.status,201);return r.body.id as string}
 const send=(id:string,key=randomUUID(),ids=[a,b])=>call('/group',{method:'POST',resource:'messages',id,body:JSON.stringify({clientMessageId:key,body:'Controlled request',mentions:ids.map(memberId=>({memberType:'agent',memberId}))})},'member')
 const complete=(c:any,body='controlled',mentions:string[]=[])=>worker({action:'complete',runId:c.runId,reply:{workId:c.runId,triggerMessageId:c.envelope.triggerMessageId,claimEpoch:c.claimEpoch,body,mentions}})
 const claim=async()=>{const p=await worker({action:'poll'});assert.equal(p.status,200);assert.equal(p.body.runIds.length,1);const c=await worker({action:'claim',runId:p.body.runIds[0]});assert.equal(c.status,200);return c.body}
 try{
  for(const name of orderMigrations((await readdir(new URL('../drizzle/',import.meta.url))).filter(n=>n.endsWith('.sql'))))await pool.query(await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8'))
  await pool.query(await readFile(new URL('../drizzle/20261025082237_group_turn_mailbox_policy.sql',import.meta.url),'utf8'))
  for(const user of ['owner','member'])await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,'member','active')`,[workspace,user,user+'@example.invalid'])
  await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,'outsider','outsider','outsider@example.invalid','member','active')`,[otherWorkspace])
  await pool.query(`INSERT INTO devices(id,"ownerId",name,enabled) VALUES($1,'owner','fixture',true)`,[device])
  for(const id of [a,b])await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1::uuid,'owner',$1::text,'codex',$2)`,[id,device])
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+((server.address() as {port:number}).port)
  await t.test('concurrent human retries create one root; one worker claims and one completion publishes',async()=>{
   const g=await group(),key=randomUUID();const sends=await Promise.all(Array.from({length:8},()=>send(g,key)))
   assert.equal(sends.filter(r=>r.status===201).length,1);assert.equal(new Set(sends.map(r=>r.body.id)).size,1)
   const polls=await Promise.all(Array.from({length:4},()=>worker({action:'poll'})));const id=polls[0].body.runIds[0];assert.ok(id)
   assert.ok(polls.every(p=>p.body.runIds.length===1&&p.body.runIds[0]===id))
   const claims=await Promise.all([worker({action:'claim',runId:id}),worker({action:'claim',runId:id})]);assert.equal(claims.filter(c=>c.status===200).length,1)
   const c=claims.find(c=>c.status===200)!.body
   // Commit the reply, then actually sever HTTP before its response; reconnect using the same identity.
   await assert.rejects(fetch(origin+'/worker',{method:'POST',headers:{'x-fixture-user':'owner','content-type':'application/json','x-drop-response':'yes'},body:JSON.stringify({action:'complete',runId:c.runId,reply:{workId:c.runId,triggerMessageId:c.envelope.triggerMessageId,claimEpoch:c.claimEpoch,body:'controlled',mentions:[]}})}))
   const results=await Promise.all([complete(c),complete(c)]);assert.equal(results[0].body.replyMessageId,results[1].body.replyMessageId)
   assert.equal((await complete(c,'different')).status,409)
   const second=await claim();assert.equal(second.envelope.untrustedData.earlier.length,1)
   assert.equal((await complete(second)).status,200)
   assert.equal((await pool.query(`SELECT count(*) FROM conversation_messages WHERE "conversationId"=$1 AND "authorType"='agent'`,[g])).rows[0].count,'2')
  })
  await t.test('three bounded serial rounds dedupe mentions and suppress no-add',async()=>{
   const g=await group();await send(g,randomUUID(),[a]);let c=await claim();await complete(c,'round0',[b,b]);c=await claim();assert.equal(c.envelope.untrustedData.round,1)
   await complete(c,'round1',[a]);c=await claim();assert.equal(c.envelope.untrustedData.round,2);await complete(c,'round2',[b])
   assert.equal((await worker({action:'poll'})).body.runIds.length,0)
   await send(g,randomUUID(),[a]);c=await claim();await complete(c,'[nothing to add]',[b]);assert.equal((await worker({action:'poll'})).body.runIds.length,0)
  })
  await t.test('lost lease is uncertain, never re-executed; human reconciliation is authorized and audited',async()=>{
   const g=await group();await send(g,randomUUID(),[a]);const c=await claim()
   await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`,[c.runId])
   assert.equal((await review(g,{action:'work',workId:c.runId})).body.executionState,'uncertain')
   assert.equal((await worker({action:'claim',runId:c.runId})).body.status,'uncertain')
   assert.equal((await worker({action:'poll'})).body.runIds.length,0);assert.equal((await complete(c)).status,409)
   assert.equal((await review(g,{action:'work',workId:c.runId})).body.executionState,'uncertain')
   for(let i=0;i<21;i++)await send(g,randomUUID(),[a])
   const independent=await group();await send(independent,randomUUID(),[a]);const independentClaim=await claim();assert.notEqual(independentClaim.envelope.conversationId,g);await complete(independentClaim)

   assert.equal((await review(g,{action:'reconcile',workId:c.runId,decision:'abandon'},'outsider')).status,404)
   assert.equal((await review(g,{action:'reconcile',workId:c.runId,decision:'abandon'})).status,200)
   assert.equal((await pool.query('SELECT count(*) FROM group_work_reconciliations WHERE "workId"=$1',[c.runId])).rows[0].count,'1')
   // Explicit fixture cancellation uses the authorized API, retaining every row.
   const waiting=(await pool.query('SELECT id FROM conversation_work WHERE "conversationId"=$1 AND status=\'pending\'',[g])).rows
   for(const row of waiting)await review(g,{action:'cancel',workId:row.id})

  })
  await t.test('lead and correction persistence; nonmember/workspace denial; revoke prevents late and queued replies',async()=>{
   const g=await group();assert.equal((await review(g,{action:'lead',agentId:a},'member')).status,403);assert.equal((await review(g,{action:'lead',agentId:a})).status,200)
   await send(g,randomUUID(),[]);await complete(await claim());await send(g,randomUUID(),[b]);await complete(await claim())
   assert.equal((await pool.query('SELECT count(*) FROM group_mailbox_corrections WHERE "conversationId"=$1',[g])).rows[0].count,'1')
   const sent=await send(g,randomUUID(),[a,b]);const c=await claim();assert.equal((await worker({action:'complete',runId:c.runId,reply:{}},'outsider')).status,404)
   assert.equal((await review(g,{action:'revoke',agentId:a})).status,200);assert.equal((await complete(c)).status,409)
   await review(g,{action:'revoke',agentId:b});assert.equal((await send(g,randomUUID(),[])).status,201);assert.equal((await worker({action:'poll'})).body.runIds.length,0)
   assert.equal((await call('/group',{method:'GET',resource:'messages',id:g},'outsider')).status,404)
   assert.equal((await pool.query(`SELECT count(*) FROM conversation_messages WHERE "replyToId"=$1 AND "authorType"='agent'`,[sent.body.id])).rows[0].count,'0')
  })
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await pool.end();await admin.end()}
 // Retain this task-owned schema for audit; no cleanup without explicit approval.
})

test('group message HTTP never imports the retired direct-provider dispatcher',async()=>{
 const source=await readFile(new URL('./group-conversations-route.ts',import.meta.url),'utf8')
 assert.doesNotMatch(source,/processGroupTurn|groupRuntime|generateText|\bafter\s*\(/)
})
