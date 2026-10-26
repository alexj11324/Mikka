import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,readdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import test from 'node:test'
import {Pool} from 'pg'
import {orderMigrations} from '../scripts/migration-order.mjs'
import {handleGroup} from './group-conversations-store'
import {groupDirectory} from './group-conversations-directory'
import {reviewArtifact} from './artifact-review-store'
import {groupReviewCommand} from './group-review-commands'
import {handleGroupWorkerRequest} from './group-worker-route'
import {SessionMailbox} from './session-mailbox'
import {groupReviewHttpLink,runGroupReviewBatch,type GroupReviewAssignment,type GroupReviewOutput} from '../packages/daemon/src/runs/group-review-worker'

const url=process.env.MIKKA_DISPOSABLE_POSTGRES_URL ?? (process.env.CI==='true' && process.env.GITHUB_ACTIONS==='true'?process.env.E2E_DATABASE_URL:undefined)
const workspaceURL=process.env.MIKKA_DISPOSABLE_WORKSPACE_POSTGRES_URL ?? url
for(const value of [url,workspaceURL])if(value){const u=new URL(value);assert.equal(u.hostname,'127.0.0.1');assert.ok(['/mikka_review','/mikka_e2e','/mikka_workspace_review'].includes(u.pathname))}
if(process.env.MIKKA_TEST_NATIVE_GROUPS==='1')assert.equal(process.env.MIKKA_NATIVE_DISPOSAL_AUTHORIZED,'1','Native profile requires explicit runtime disposal authorization before any fixture executes')
test('actual HTTP dispatch → group mailbox → isolated fake worker → trusted revision', {skip:!url},async t=>{
 const fixtureContainer='mikka-group-fixture-'+randomUUID()
 const schema='bridge_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url})
 const wsAdmin=new Pool({connectionString:workspaceURL})
 await admin.query(`CREATE SCHEMA "${schema}"`);await wsAdmin.query(`CREATE SCHEMA "${schema}_ws"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:8}),ws=new Pool({connectionString:workspaceURL,options:`-c search_path=${schema}_ws`,max:4})
 const workspaceId=randomUUID(),agentId=randomUUID(),ccAgentId=randomUUID(),deviceId=randomUUID(),foreignDevice=randomUUID()
 const directory=groupDirectory({async activeUsers(w,ids){return(await ws.query('SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status=\'active\'',[w,ids])).rows.map(r=>r.userId)},async ownedAgents(u,ids,client){return(await(client??pool).query('SELECT id FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])',[u,ids])).rows.map(r=>r.id)}})
 let port=0
 const server=createServer(async(req,res)=>{
  try{
   const parts=[];for await(const part of req)parts.push(part)
   const path=req.url??''
   const send=(body:unknown)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body))}
   if(path==='/v1/devices/register'){send({deviceId,workspaceId});return}
   if(path.endsWith('/heartbeat')){send({leases:{}});return}
   if(path.endsWith('/repos')){send({repos:[]});return}
   if(path.includes('/runs?')){send({runIds:[]});return}
   if(path.includes('/commands?')){await new Promise(r=>setTimeout(r,100));send({commands:[]});return}
   if(path.includes('/fs/')){await new Promise(r=>setTimeout(r,100));send({requests:[]});return}
   const request=new Request(`http://127.0.0.1:${port}${req.url}`,{method:'POST',headers:req.headers as Record<string,string>,body:Buffer.concat(parts)})
   let result:Response
   if(req.url==='/worker'||req.url?.endsWith('/group-reviews'))result=await handleGroupWorkerRequest(request,deviceId,{pool,directory,authenticate:async r=>{const u=r.headers.get('authorization')==='Bearer controlled-device-fixture'?'owner':r.headers.get('x-controlled-identity');return ['owner','member','outsider'].includes(u??'')?{userId:u!}:null}})
   else{
    const body=await request.json(),userId=request.headers.get('x-controlled-identity')
    if(!userId)result=Response.json({error:'unauthorized'},{status:401})
    else if(req.url==='/groups'){const out=await handleGroup(pool,directory,{userId,method:'POST',resource:'conversations',body:JSON.stringify(body),origin:null,host:`127.0.0.1:${port}`});result=Response.json(out.body,{status:out.status})}
    else result=Response.json(await reviewArtifact(pool,directory,req.url!.slice('/artifacts/'.length),userId,body))
   }
   res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text())
  }catch(error){res.writeHead((error as {status?:number}).status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:(error as Error).message}))}
 })
 async function post(path:string,input:unknown,user='owner'){const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{'content-type':'application/json','x-controlled-identity':user},body:JSON.stringify(input)});const value=await r.json();if(!r.ok)throw Object.assign(new Error(value.error),{status:r.status});return value}
 const worker=(input:unknown,user='owner')=>post('/worker',input,user)
 const newRequest=async(target=agentId,comment="Improve this quote.")=>{
  const group=await post('/groups',{workspaceId,title:'Review',members:[{memberType:'user',memberId:'member'},{memberType:'agent',memberId:target}]})
  const path='/artifacts/'+group.id,created=await post(path,{action:'create',title:'Plan',mediaType:'text/markdown',currentAgentId:target,content:'hello world!'})
  const base={artifactId:created.artifactId,baseVersionId:created.version.id,baseHash:created.version.hash}
  const thread=await post(path,{action:'thread',...base,anchor:{kind:'source-range',start:6,end:11,quote:'world',prefix:'hello ',suffix:'!'},body:comment},'member')
  const count=(await pool.query('SELECT count(*) FROM conversation_work WHERE "conversationId"=$1',[group.id])).rows[0].count;assert.equal(count,'0')
  const send={action:'send',...base,threadId:thread.threadId,requestId:randomUUID()}
  const work=await post(path,send,'member');assert.equal((await post(path,send,'member')).workId,work.workId)
  return{group,path,base,work,thread}
 }
 const claim=async(id:string)=>worker({action:'claim',runId:id}) as Promise<GroupReviewAssignment>
 const output=(c:GroupReviewAssignment):GroupReviewOutput=>{const a=(c.envelope.untrustedData as {artifact:{artifactId:string;baseVersionId:string;hash:string}}).artifact;return{body:'Proposed a revision for review.',proposal:{artifactId:a.artifactId,baseVersionId:a.baseVersionId,baseHash:a.hash,content:'hello improved world!'}}}
 const complete=(c:GroupReviewAssignment,o=output(c))=>worker({action:'complete',runId:c.runId,reply:{...o,workId:c.envelope.workId,triggerMessageId:c.envelope.triggerMessageId,claimEpoch:c.claimEpoch}})
 try{
  for(const name of orderMigrations((await readdir(new URL('../drizzle/',import.meta.url))).filter(n=>n.endsWith('.sql')))){
   const sql=await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8');await(/^--\s*target:\s*DATABASE_URL/m.test(sql)?ws:pool).query(sql)
  }
  await pool.query(await readFile(new URL('../drizzle/20261025052033_group_review_mailboxes.sql',import.meta.url),'utf8'))
  for(const u of ['owner','member','outsider'])await ws.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'member\',\'active\')',[workspaceId,u,u+'@example.invalid'])
  await pool.query('INSERT INTO devices (id,"ownerId",name,enabled) VALUES ($1,\'owner\',\'controlled fixture\',true),($2,\'outsider\',\'foreign\',true)',[deviceId,foreignDevice])
  await pool.query('INSERT INTO agents (id,"userId",name,harness,instructions,"deviceId") VALUES ($1,\'owner\',\'Agent\',\'codex\',\'PRIVATE_INSTRUCTIONS_SENTINEL\',$2)',[agentId,deviceId])
  await pool.query('INSERT INTO agents (id,"userId",name,harness,instructions,"deviceId") VALUES ($1,\'owner\',\'CC Agent\',\'claude_code\',\'PRIVATE_INSTRUCTIONS_SENTINEL\',$2)',[ccAgentId,deviceId])
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));port=(server.address() as {port:number}).port
  await t.test('real app handlers persist request, worker HTTP dispatches once, Docker-isolated fake proposes revision and completion ACKs atomically',async()=>{
   const r=await newRequest()
   assert.equal((await pool.query('SELECT count(*) FROM agent_runs')).rows[0].count,'0')
   const replies=await runGroupReviewBatch(groupReviewHttpLink(input=>worker(input)),async(assignment,signal)=>{
    assert.ok(!JSON.stringify(assignment).includes('PRIVATE_INSTRUCTIONS_SENTINEL'))
    assert.deepEqual(assignment.capabilities,{tools:[],history:[],repository:null,credentials:null})
    // No host mounts, network, inherited environment, writable root or privileges.
    const child=spawn('docker',['run','--name',fixtureContainer,...(process.env.KEEP_GROUP_TEST_FIXTURES?[]:['--rm']),'--interactive','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','65534','--pids-limit','32','node:24-bookworm-slim','node','-e',`let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{let a=JSON.parse(s).envelope.untrustedData.artifact;console.log(JSON.stringify({body:'Proposed a revision for review.',proposal:{artifactId:a.artifactId,baseVersionId:a.baseVersionId,baseHash:a.hash,content:'hello improved world!'}}))})`],{env:{PATH:process.env.PATH,NODE_ENV:'test'},signal})
    let text='',err='';child.stdout.on('data',d=>text+=d);child.stderr.on('data',d=>err+=d);child.stdin.end(JSON.stringify(assignment))
    await new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(err)))})
    return JSON.parse(text)
   })
   assert.equal(replies.length,1)
   const detail=await post(r.path,{action:'read',artifactId:r.base.artifactId})
   assert.equal(detail.versions.length,2);assert.equal(detail.artifact.acceptedVersionId,null);assert.equal(detail.requests[0].status,'completed')
   assert.equal((await pool.query('SELECT count(*) FROM conversation_messages WHERE "conversationId"=$1 AND "authorType"=\'agent\'',[r.group.id])).rows[0].count,'1')
   const rows=(await pool.query('SELECT "acknowledgedAt" FROM run_messages WHERE "runId"=$1',[r.work.workId])).rows;assert.ok(rows[0].acknowledgedAt)
   assert.deepEqual((await worker({action:'poll'})).runIds,[])
   assert.equal((await pool.query('SELECT count(*) FROM coordinator_events')).rows[0].count,'0','group outputs never enter private coordinator')
   await post(r.path,{action:'accept',artifactId:r.base.artifactId,baseVersionId:detail.versions[1].id,baseHash:detail.versions[1].hash},'member')
  })
  await t.test('concurrent claims are exclusive; lease replay fences old output and completion deduplicates',async()=>{
   const r=await newRequest();await Promise.all([worker({action:'poll'}),worker({action:'poll'})])
   assert.equal((await pool.query('SELECT count(*) FROM run_messages WHERE "runId"=$1',[r.work.workId])).rows[0].count,'1')
   const attempts=await Promise.allSettled([claim(r.work.workId),claim(r.work.workId)])
   assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1)
   const first=(attempts.find(a=>a.status==='fulfilled') as PromiseFulfilledResult<GroupReviewAssignment>).value
   await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()-interval \'1 second\' WHERE id=$1',[first.runId])
   await assert.rejects(complete(first),/claim_expired/)
   const uncertain=await worker({action:'claim',runId:first.runId});assert.equal(uncertain.status,'uncertain')
   await assert.rejects(complete(first),/execution_uncertain/)
   const state=await groupReviewCommand(pool,directory,r.path.slice('/artifacts/'.length),'owner',{action:'work',workId:first.runId})
   assert.equal(state.executionState,'uncertain')

  })
  await t.test('cross-owner/browser spoofing and private mailbox routes cannot enter a group mailbox',async()=>{
   const r=await newRequest();await worker({action:'poll'})
   await assert.rejects(worker({action:'claim',runId:r.work.workId},'outsider'),/not_found/)
   await assert.rejects(worker({action:'fail',runId:r.work.workId,claimEpoch:1,code:'processor_failed'},'outsider'),/not_found/)
   await assert.rejects(worker({action:'poll',userId:'owner'}),/invalid_input/)
   await assert.rejects(worker({action:'claim',runId:r.work.workId,harness:'claude_code'}),/invalid_input/)
   await assert.rejects(worker({action:'poll'},''),/unauthorized/)
   const box=(await pool.query('SELECT "mailboxId" FROM agent_runs WHERE id=$1',[r.work.workId])).rows[0].mailboxId
   const store=new SessionMailbox(pool,workspaceId),actor=await store.conversation('owner','coordinator')
   assert.ok(!(await store.recipients(actor)).recipients.some(b=>b.id===box))
   await assert.rejects(store.ownerView('owner',box),/unavailable/);await assert.rejects(store.run('owner',r.work.workId),/authorized/)
   await assert.rejects(store.send(actor,{to:box,key:randomUUID(),text:'bypass'}),/unavailable/)
   const c=await claim(r.work.workId);await assert.rejects(worker({action:'complete',runId:c.runId,reply:{...output(c),workId:c.runId,triggerMessageId:c.envelope.triggerMessageId,claimEpoch:c.claimEpoch,authorType:'agent'}}),/invalid_input/)
   await complete(c)
  })
  await t.test('a concurrent human revision retains losing immutable proposal without accepting it',async()=>{
   const r=await newRequest();await worker({action:'poll'});const c=await claim(r.work.workId)
   const human=await post(r.path,{action:'revise',...r.base,content:'winning human version'})
   assert.equal((await complete(c)).status,'conflict')
   const detail=await post(r.path,{action:'read',artifactId:r.base.artifactId});assert.equal(detail.artifact.headVersionId,human.version.id);assert.equal(detail.versions.length,3);assert.equal(detail.artifact.acceptedVersionId,null)
  })
  await t.test('cancellation, revoked grants and workspace suspension block delivery and late completion',async()=>{
   let r=await newRequest();await groupReviewCommand(pool,directory,r.group.id,'member',{action:'cancel',workId:r.work.workId});await worker({action:'poll'});assert.equal((await pool.query('SELECT "runId" FROM conversation_work WHERE id=$1',[r.work.workId])).rows[0].runId,null)
   r=await newRequest();await worker({action:'poll'});const c=await claim(r.work.workId)
   await groupReviewCommand(pool,directory,r.group.id,'owner',{action:'revoke',agentId});await assert.rejects(complete(c),/work_not_live/)
   r=await newRequest();await worker({action:'poll'});await ws.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "userId"=\'member\'')
   assert.equal((await worker({action:'claim',runId:r.work.workId})).status,'cancelled')
   await ws.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "userId"=\'member\'')
  })
  await t.test('reply, proposed version, mailbox ACK and terminal state roll back together and retry safely',async()=>{
   const r=await newRequest();await worker({action:'poll'});const c=await claim(r.work.workId)
   await pool.query(`CREATE TABLE group_ack_fault (active boolean NOT NULL); INSERT INTO group_ack_fault VALUES(true); CREATE FUNCTION fail_group_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT active FROM group_ack_fault) THEN RAISE EXCEPTION 'simulated ACK persistence failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_group_ack BEFORE UPDATE OF "acknowledgedAt" ON run_messages FOR EACH ROW EXECUTE FUNCTION fail_group_ack()`)
   await assert.rejects(complete(c),/simulated ACK/)
   assert.equal((await post(r.path,{action:'read',artifactId:r.base.artifactId})).versions.length,1)
   assert.equal((await pool.query('SELECT status FROM conversation_work WHERE id=$1',[c.runId])).rows[0].status,'dispatched')
   await pool.query('UPDATE group_ack_fault SET active=false');await complete(c)
   assert.equal((await post(r.path,{action:'read',artifactId:r.base.artifactId})).versions.length,2)
  })
  await t.test('additive group mailbox backfill preserves identity and hides old group runs from private discovery',async()=>{
   const r=await newRequest();await worker({action:'poll'})
   const box=(await pool.query('SELECT "mailboxId" FROM agent_runs WHERE id=$1',[r.work.workId])).rows[0].mailboxId
   await pool.query(`UPDATE session_mailboxes SET kind='run',"workspaceId"='legacy-singleton',"wakeBudget"=2 WHERE id=$1`,[box])
   await pool.query('UPDATE run_messages SET "mailboxId"=null WHERE "runId"=$1',[r.work.workId])
   const sql=await readFile(new URL('../drizzle/20261025052033_group_review_mailboxes.sql',import.meta.url),'utf8')
   await pool.query(sql);await pool.query(sql)
   const row=(await pool.query('SELECT * FROM session_mailboxes WHERE id=$1',[box])).rows[0]
   assert.equal(row.kind,'group');assert.equal(row.workspaceId,workspaceId);assert.equal(row.wakeBudget,0)
   assert.equal((await pool.query('SELECT "mailboxId" FROM run_messages WHERE "runId"=$1',[r.work.workId])).rows[0].mailboxId,box)
   await complete(await claim(r.work.workId))
  })
  await t.test('running worker aborts on revocation without posting late output',async()=>{
   const r=await newRequest()
   await assert.rejects(runGroupReviewBatch(groupReviewHttpLink(input=>worker(input)),async(_input,signal)=>{
    await groupReviewCommand(pool,directory,r.group.id,'owner',{action:'revoke',agentId})
    return new Promise<GroupReviewOutput>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('controlled worker stopped')),{once:true}))
   }),/stopped/)
   assert.equal((await pool.query('SELECT status FROM conversation_work WHERE id=$1',[r.work.workId])).rows[0].status,'cancelled')
   assert.equal((await pool.query('SELECT count(*) FROM artifact_versions WHERE "artifactId"=$1',[r.base.artifactId])).rows[0].count,'1')
  })
  if(process.env.MIKKA_TEST_NATIVE_GROUPS==='1'){
   const nativeURL=new URL('../packages/daemon/test/group-native-acceptance.ts',import.meta.url).href
   const {nativeGroupAcceptance}=await import(nativeURL)
   await t.test('actual daemon startup routes BOTH CC/Codex CLI adapters with isolated fake binaries',()=>nativeGroupAcceptance({pool,command:(id:string,user:string,input:unknown)=>groupReviewCommand(pool,directory,id,user,input),port,agentId,ccAgentId,newRequest,post,worker}))
  }
  for(const table of ['session','account','device_tokens','run_tokens'])assert.equal((await pool.query(`SELECT count(*) FROM "${table}"`)).rows[0].count,'0')
 }finally{if(process.env.KEEP_GROUP_TEST_FIXTURES)console.log('Group retained fixtures: '+JSON.stringify({appSchema:schema,workspaceSchema:schema+'_ws',container:fixtureContainer}));await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();await ws.end();if(!process.env.KEEP_GROUP_TEST_FIXTURES)await admin.query(`DROP SCHEMA "${schema}" CASCADE`);if(!process.env.KEEP_GROUP_TEST_FIXTURES)await wsAdmin.query(`DROP SCHEMA "${schema}_ws" CASCADE`);await admin.end();await wsAdmin.end()}
})
