import assert from 'node:assert/strict'
import { createHash,randomUUID } from 'node:crypto'
import { appendFileSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs'
import { serve } from 'srvx/node'
import { join } from 'node:path'
import { Pool } from 'pg'
import { ACTIVE_TURN_STEER_HEADER,SOURCE_DAEMON_VERSION } from '@mikka/protocol/device'
import { CLIENT_VERSION_HEADER } from '@mikka/protocol/version'
import { normalizeRepository } from '@mikka/protocol/repository'
import { seedUser,seedWorkspace,seedIssue } from '../../tests/support/workspace-admin-db'
import { ClaudeAdapter } from '../../packages/daemon/src/adapters/claude'
import { ToolApprovalGate } from '../../packages/daemon/src/agents/tool-approval'
import { buildChildEnv } from '../../packages/daemon/src/env'
import { createLogger } from '../../packages/daemon/src/log'

const dir=process.env.E_CODEX_QA!,origin=process.env.BETTER_AUTH_URL!
const model='SmolLM2-135M-Instruct-Q4_K_M'
const interrupt=process.env.E_FACTORY_INTERRUPT==='1'
const runId=randomUUID(),deviceId=randomUUID(),agentId=randomUUID(),repoId=randomUUID()
const handin=process.env.E_AFTER_RUN==='1'
const trace:any={source:process.env.E_RUN_SOURCE,runId,deviceId,cli:process.env.E_CODEX_VERSION,model,weightSha256:process.env.E_WEIGHT_SHA,cliSha256:process.env.E_CLI_BINARY_SHA,stages:[],scope:'Actual cookie-authenticated browser RPC and device REST over loopback HTTP. Only the bridge between returned device commands and the unmodified ClaudeAdapter is an explicit QA driver. Provider uses real GGUF inference and paced transport. No subscription or production release.'}
const persist=()=>writeFileSync(join(dir,'delivery.json'),JSON.stringify(trace,null,2),{mode:0o600})
const note=(stage:string,data:any={})=>{trace.stages.push({stage,at:new Date().toISOString(),...data});persist()}
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const mark=(s:string)=>'E2262_QA_BEGIN '+s+' E2262_QA_END'
const initial=handin?'The user wants the finished report delivered. Choose submit, not answer. The report should say which color a clear daytime sky is.':'List twenty vegetables with a sentence about each.',steer='Name the capital of France in one short sentence.'
const h=(s:string)=>createHash('sha256').update(s).digest('hex')
const dbUrl=process.env.E2E_DATABASE_URL!
assert.equal(new URL(dbUrl).hostname,'127.0.0.1');assert.equal(new URL(dbUrl).pathname,'/mikka_e2e')
assert.equal(origin,'http://127.0.0.1:3859')
const independent=new Pool({connectionString:dbUrl,max:2})
let http:any,session:any
try {
 const version=(await independent.query('show server_version_num')).rows[0].server_version_num
 assert.match(version,/^17/);note('isolated migrated PostgreSQL', {version})
 const {default:api}=await import('../../apps/api/src/index')
 http=serve({hostname:'127.0.0.1',port:3859,fetch:api.fetch,gracefulShutdown:false,silent:true})
 await http.ready()
 const owner=await seedUser(independent,'e-owner'),member=await seedUser(independent,'e-member')
 const ws=await seedWorkspace(independent,owner,[{userId:owner,role:'admin'},{userId:member,role:'member'}])
 const issueId=await seedIssue(independent,owner,ws.id,{registered:true})
 await independent.query('UPDATE issues SET content=$2 WHERE id=$1',[issueId,{type:'doc',attrs:{mikka:{number:1}}}])
 const remote='https://github.com/octo/fixture.git'
 await independent.query(`insert into devices(id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) values($1,$2,'Synthetic CI Linux','local','laptop',true,now(),$3)`,[deviceId,owner,JSON.stringify([{harness:'claude_code',installed:true,toolApproval:true}])])
 await independent.query(`insert into agents(id,"userId","deviceId",harness,name) values($1,$2,$3,'claude_code','Synthetic CPU model')`,[agentId,owner,deviceId])
 await independent.query(`insert into device_repos(id,"deviceId","userId","repoPath","remoteUrl") values($1,$2,$3,$4,$5)`,[repoId,deviceId,owner,normalizeRepository(remote).key,remote])
 const {acceptLocalRun}=await import('../../lib/run-admission-store')
 const prompt=mark(initial)
 const seedInput={id:runId,userId:owner,issueId,agentId,deviceId,deviceRepoId:repoId,botId:null,origin:'web',prompt,promptTaskStart:0,promptTaskLength:[...prompt].length,definition:{schemaVersion:1,kind:'worker',harness:'claude_code',instructions:'Use only the local model for this synthetic prompt.',definitionDigest:h('synthetic'),promptDigest:h(prompt),model,modelSource:'native-default',parent:null,readOnly:true} as never,dispatch:{issueId,agentId,deviceRepoId:repoId,requestKey:randomUUID()}}
 const {pool}=await import('../../lib/db')
 const {withProjectResourceLease}=await import('../../lib/project-resources/store')
 const {queueFactoryTask}=await import('../../lib/factory/task-dispatch')
 const admitted=interrupt?await withProjectResourceLease(owner,ws.id,()=>queueFactoryTask(pool,owner,{issueId,botId:null,agentId,deviceRepoId:repoId,note:prompt,key:randomUUID(),queue:(tx,userId,req,botId,ctx)=>acceptLocalRun({...seedInput, userId,botId,factoryContext:ctx},tx)})):await acceptLocalRun(seedInput)
 assert.equal(admitted.runId,runId);note('canonical admission',{issueId,workspaceId:ws.id})
 const {auth}=await import('../../lib/auth')
 const signIn=async(user:string)=>{
  const context=await auth.$context,password=randomUUID()+randomUUID()
  await context.internalAdapter.createAccount({userId:user,accountId:user,providerId:'credential',password:await context.password.hash(password)})
  const resp=await auth.api.signInEmail({body:{email:user+'@example.invalid',password},headers:new Headers({origin}),returnHeaders:true})
  const jar=resp.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.ok(jar);return jar+'; mikka-workspace='+ws.id
 }
 const ownerCookie=await signIn(owner),memberCookie=await signIn(member)
 const {issueDeviceToken}=await import('../../lib/device-link')
 const token=await issueDeviceToken(owner,'Synthetic acceptance')
 const dcall=async(path:string,method='GET',payload?:unknown,expected=200)=>{
  note('device REST request',{method,path:path.split('?')[0]})
  const res=await fetch(origin+'/mikka/v1/'+path,{method,headers:{authorization:'Bearer '+token,[CLIENT_VERSION_HEADER]:SOURCE_DAEMON_VERSION,[ACTIVE_TURN_STEER_HEADER]:'1','content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})})
  note('device REST response',{method,path:path.split('?')[0],status:res.status})
  assert.equal(res.status,expected,method+' '+path+' '+res.status)
  return expected===204?null:res.json()
 }
 const rpc=async(cookie:string,name:string,args:any)=>{
  const res=await fetch(origin+'/mikka/api/rpc',{method:'POST',headers:{origin,cookie,'content-type':'application/json','x-mikka-rpc':'1','sec-fetch-site':'same-origin'},body:JSON.stringify({version:1,action:'agents.'+name,args:[{issueId,runId,...args}]})})
  const body=await res.json();assert.equal(res.status,200,JSON.stringify(body));assert.equal(body.ok,true,JSON.stringify(body));return body.result
 }
 const post=(cookie:string,text:string,requestId:string)=>rpc(cookie,'sendIssueThreadReply',{text,delivery:'queue',requestId})
 const queueRow=async(requestId:string)=>(await independent.query('SELECT id,status,"sentRunId","claimMode","requestedRunId" FROM thread_queued_messages WHERE "requestId"=$1',[requestId])).rows[0]
 const reqId=randomUUID(),text=mark(steer)
 const forbidden=await post(memberCookie,text,randomUUID());assert.ok(['runNotFound','workspaceAccessDenied','issueNotFound','notFound'].includes(forbidden.error),JSON.stringify(forbidden))
 assert.equal((await independent.query('SELECT count(*)::int AS n FROM thread_queued_messages WHERE "runId"=$1',[runId])).rows[0].n,0)
 const admittedQueue=await post(ownerCookie,text,reqId);assert.deepEqual(admittedQueue,{sent:true,runId,continued:false});assert.deepEqual(await post(ownerCookie,text,reqId),admittedQueue)
 const waiting=await queueRow(reqId);assert.equal(waiting.status,'queued');assert.equal(waiting.requestedRunId,runId);assert.equal(waiting.sentRunId,null)
 const cancelledId=randomUUID();await post(ownerCookie,'Retain this cancelled synthetic input.',cancelledId);const toCancel=await queueRow(cancelledId)
 assert.deepEqual(await rpc(ownerCookie,'changeQueuedThreadReply',{messageId:toCancel.id,action:'cancel'}),{status:'cancelled'})
 assert.equal((await queueRow(cancelledId)).status,'cancelled')
 note('owner queued; replay returned same receipt; separate queue cancelled; member denied',{messageId:waiting.id,denied:forbidden.error,waiting})
 const devicePath='devices/'+deviceId+'/commands',pending=await dcall(devicePath+'?wait=0')
 assert.ok(pending.commands.every((c:any)=>c.kind!=='steer'));assert.ok(!(await independent.query('SELECT id FROM run_messages WHERE "runId"=$1',[runId])).rowCount)
 const {threadDeliveryView}=await import('../../lib/thread-delivery-queue')
 const root=join(dir,'fixture'),cwd=join(root,'work'),home=join(root,'home'),stateDir=join(root,'adapters')
 mkdirSync(stateDir,{recursive:true})
 const adapter=new ClaudeAdapter({stateDir,binary:process.env.E_CLI_BINARY!})
 session=await adapter.start({runId,cwd,prompt,model,log:createLogger({level:'silent'}),env:buildChildEnv({host:{PATH:process.env.PATH,HOME:home,SSL_CERT_FILE:join(dir,'ephemeral-ca.pem'),NODE_EXTRA_CA_CERTS:join(dir,'ephemeral-ca.pem'),LANG:'C.UTF-8'},runId}),credential:{kind:'provider',protocol:'anthropic',baseUrl:'https://127.0.0.1:3857',key:process.env.E_LOOPBACK_KEY!},toolApproval:new ToolApprovalGate(runId,{isLive:()=>true})})
 await dcall('runs/'+runId,'PATCH',{state:'running',sessionId:session.sessionId},204)
 note('device reported real native thread',{thread:session.sessionId,reportedModel:session.runtimeModel})
 let changed=false,transcript='',terminal:any
 const chunks:any[]=[]
 const replacementQuestion='What color is a ripe banana? Answer in one short sentence.'
 let replacementAttempt:string|undefined
 const currentModes=await threadDeliveryView(pool,owner,runId,runId)
 assert.ok(currentModes.modes.includes('queue'));assert.ok(!currentModes.modes.includes('steer'),'Claude does not guarantee steering the live turn')
 const refused=await rpc(ownerCookie,'sendIssueThreadReply',{text:'No steer for Claude.',delivery:'steer',requestId:randomUUID()})
 assert.equal(refused.error,'threadDeliveryUnavailable')
 note('actual product allowed modes and unsupported direct steer denial',{modes:currentModes.modes,denied:refused.error})
 const interruptAfterFirstInference=async()=>{
  if(!interrupt)return
  const end=Date.now()+60000
  const started=()=>{try{return readFileSync(join(dir,'claude-first-token.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)).some(v=>v.prompt===initial)}catch{return false}}
  while(Date.now()<end&&!started())await wait(30)
  assert.ok(started(),'An actual Claude request must generate model tokens before interruption')
  changed=true
  const current=await threadDeliveryView(pool,owner,runId,runId)
  if(interrupt){
   assert.ok(current.modes.includes('interrupt'),JSON.stringify(current.modes))
   const active=async()=>(await independent.query(`SELECT t.id,t."attemptId",t."sourceEventId",t.status FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1 AND t."userId"=$2`,[runId,owner])).rows[0]
   const previous=await active();assert.equal(previous.status,'running')
   const interruptId=randomUUID(),replacement=mark(replacementQuestion)
   const change=(cookie:string,rid:string)=>rpc(cookie,'sendIssueThreadReply',{text:replacement,requestId:rid,delivery:'interrupt'})
   const refused=await change(memberCookie,randomUUID());assert.ok(['runNotFound','workspaceAccessDenied','issueNotFound','notFound'].includes(refused.error),JSON.stringify(refused))
   assert.deepEqual(await active(),previous)
   const request=await change(ownerCookie,interruptId);assert.deepEqual(request,{sent:true,runId,continued:false})
   assert.deepEqual(await change(ownerCookie,interruptId),request)
   const next=await active();replacementAttempt=next.attemptId;assert.notEqual(next.sourceEventId,previous.sourceEventId);assert.notEqual(next.attemptId,previous.attemptId)
   const old=(await independent.query(`SELECT a.status,r."stopRequestedAt",a.output->>'supersededBy' AS superseded FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a.id=$1`,[previous.attemptId])).rows[0]
   assert.ok(old.stopRequestedAt);assert.equal(old.status,'cancelled');assert.equal(old.superseded,next.sourceEventId)
   const heldBeforeStop=await queueRow(reqId);assert.equal(heldBeforeStop.status,'failed');assert.equal(heldBeforeStop.sentRunId,null)
   note('explicit replacement atomically failed old pending input before device acknowledged',{heldBeforeStop})
   const commands=(await dcall(devicePath+'?wait=0')).commands;assert.ok(commands.some((v:any)=>v.kind==='stop'&&v.runId===runId))
   note('owner interrupt RPC committed new request epoch and bound stop; member denied, owner replay idempotent',{previous,next,old,denied:refused.error})
   await session.cancel()
  }
 }
 const deliveryControl=interruptAfterFirstInference()
 const drain=async()=>{for await(const event of session.events()){
  if(event.type==='exit'){terminal=event;continue}
  if(event.type!=='chunk')continue
  const c=event.chunk;chunks.push(c);if(c.type==='text-delta')transcript+=c.delta
 }}
 await Promise.all([deliveryControl,drain()])
 assert.equal(terminal?.outcome,interrupt?'cancelled':'succeeded');if(!handin)assert.ok(changed)
 const provider=null
 if(interrupt)assert.ok(readFileSync(join(dir,'claude-first-token.jsonl'),'utf8').includes(initial))
 const batch={fromSeq:1,chunks},eventsUrl='runs/'+runId+'/events'
 if(chunks.length){const first=await dcall(eventsUrl,'POST',batch),retry=await dcall(eventsUrl,'POST',batch);assert.deepEqual(retry,first)}
 const rows=(await independent.query('SELECT seq,chunk FROM run_chunks WHERE "runId"=$1 ORDER BY seq',[runId])).rows
 assert.equal(rows.length,chunks.length);if(!handin)assert.equal(rows.map(v=>v.chunk.type==='text-delta'?v.chunk.delta:'').join(''),transcript)
 // Mirror the existing supervisor stopReasonOf rules for the two observed
 // cases. No tool submission or handoff can be inferred from a model answer.
 if(!handin)assert.equal(terminal.stopReason,undefined)
 const completion=handin?{stopReason:terminal.stopReason,report:{...terminal.report,filesChanged:[],verify:{status:'not_run'}}}:{stopReason:interrupt?'cancelled':'turn_ended'}
 if(handin){
  assert.equal(terminal.stopReason,'submitted')
  const decisions=readFileSync(join(dir,'decisions.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s))
  assert.ok(decisions.some(v=>{const out=JSON.parse(v.generated);return out.action==='submit'&&out.summary===terminal.report.summary}))
  assert.equal((await queueRow(reqId)).status,'queued')
  note('authentic MCP handoff before completion writer',{submitted:terminal.report.summary})
 }
 await dcall('runs/'+runId+'/complete','POST',completion,204)
 const stored=(await independent.query('SELECT status,"stopReason","finishedAt","sessionId",report->>\'summary\' AS summary FROM agent_runs WHERE id=$1',[runId])).rows[0]
 assert.equal(stored.status,handin?'succeeded':interrupt?'cancelled':'stopped');assert.equal(stored.stopReason,completion.stopReason);assert.equal(stored.sessionId,session.sessionId);assert.equal(stored.summary,handin?terminal.report.summary:null);assert.ok(stored.finishedAt)
 const copies=(await independent.query('SELECT count(*)::int AS n FROM run_messages WHERE "runId"=$1 AND text=$2',[runId,text])).rows[0].n
 if(!handin)assert.equal(copies,interrupt?0:1)
  const getRun=async(id:string)=>(await independent.query(`SELECT id,prompt,status,"sessionId","continuesRunId","issueId","workspaceId","stopReason","lastReply","agentDefinition"->>'model' AS model FROM agent_runs WHERE id=$1`,[id])).rows[0]
  const execute=async(resultRun:string,accepted:any,question:string)=>{
  const realSession=await adapter.start({runId:resultRun,cwd,prompt:accepted.prompt,model:accepted.model,log:createLogger({level:'silent'}),env:buildChildEnv({host:{PATH:process.env.PATH,HOME:home,SSL_CERT_FILE:join(dir,'ephemeral-ca.pem'),NODE_EXTRA_CA_CERTS:join(dir,'ephemeral-ca.pem'),LANG:'C.UTF-8'},runId:resultRun}),credential:{kind:'provider',protocol:'anthropic',baseUrl:'https://127.0.0.1:3857',key:process.env.E_LOOPBACK_KEY!},toolApproval:new ToolApprovalGate(resultRun,{isLive:()=>true})})
  await dcall('runs/'+resultRun,'PATCH',{state:'running',sessionId:realSession.sessionId},204)
  const followChunks:any[]=[];let followExit:any
  for await(const e of realSession.events()){if(e.type==='chunk')followChunks.push(e.chunk);else if(e.type==='exit')followExit=e}
  assert.equal(followExit.outcome,'succeeded');assert.equal(followExit.stopReason,undefined)
  const messageId=followChunks.find(c=>c.type==='text-delta')?.id.replace(/-\d+$/,'');const result=readFileSync(join(dir,'claude-results.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)).find(v=>v.id===messageId&&v.prompt===question);const answer=result&&{result:result.output,outputTokens:result.output_tokens}
  assert.ok(answer&&answer.outputTokens>0)
  const body=followChunks.filter(c=>c.type==='text-delta').map(c=>c.delta).join('');assert.equal(body,answer.result)
  await dcall('runs/'+resultRun+'/events','POST',{fromSeq:1,chunks:followChunks})
  await dcall('runs/'+resultRun+'/complete','POST',{stopReason:'turn_ended'},204)
  const final=await getRun(resultRun);assert.equal(final.lastReply,answer.result);assert.equal(final.status,'stopped');assert.equal(final.stopReason,'turn_ended')
  assert.equal(final.sessionId,realSession.sessionId)
  return {resultRun,thread:realSession.sessionId,answer:answer.result,tokens:answer.outputTokens,part:followChunks.find(c=>c.type==='text-delta')?.id,final}
  }

 if(handin){
  const queued=await queueRow(reqId);note('automatic queue receipt after actual parent completion',{queued,stored})
  assert.equal(queued.status,'sent','terminal writer must automatically admit a follow-up')
  assert.equal(queued.claimMode,'afterRun');assert.ok(queued.sentRunId&&queued.sentRunId!==runId)
  const resultRun=queued.sentRunId

  const accepted=await getRun(resultRun);assert.equal(accepted.continuesRunId,runId);assert.equal(accepted.issueId,issueId);assert.equal(accepted.workspaceId,ws.id);assert.equal(accepted.model,model);assert.ok(accepted.prompt.includes(text))
  assert.equal((await independent.query('SELECT count(*)::int AS n FROM agent_runs WHERE "continuesRunId"=$1',[runId])).rows[0].n,1)
  const offered=(await dcall(devicePath+'?wait=0')).queuedRuns??[];assert.ok(offered.includes(resultRun),JSON.stringify(offered))
  const actual=await execute(resultRun,accepted,steer)
  await dcall('runs/'+runId+'/complete','POST',completion,204)
  assert.deepEqual(await queueRow(reqId),queued)
  const record=(await independent.query('SELECT id,"runId","deliveredAt" FROM run_messages WHERE "userId"=$1 AND text=$2',[owner,text])).rows;assert.equal(record.length,1);assert.equal(record[0].runId,resultRun)
  note('automatic child executed actual queued request through native Claude Code, persistent independent read after completion and replay',{parent:runId,child:resultRun,model:actual.final.model,childThread:actual.thread,childOutcome:actual.final.status,childText:actual.answer,modelTokens:actual.tokens,ownerMessage:record[0]})
  if(process.env.E_TEST_VERSIONS==='1'){
   const versioned=(cookie:string,change:any)=>rpc(cookie,'createThreadReplyVersion',{change})
   const editQuestion='What color is a ripe banana? Answer in one short sentence.'
   const edit={operation:'edit',anchorRunId:resultRun,anchorKey:record[0].id,requestId:randomUUID(),text:mark(editQuestion)}
   const denied=await versioned(memberCookie,edit);assert.ok(['runNotFound','issueNotFound','workspaceAccessDenied'].includes(denied.error))
   const edited=await versioned(ownerCookie,edit);assert.ok(edited.versionId&&edited.runId!==resultRun,JSON.stringify(edited))
   assert.deepEqual(await versioned(ownerCookie,edit),edited)
   const editRun=await getRun(edited.runId);assert.equal(editRun.continuesRunId,resultRun);assert.equal(editRun.model,model);assert.ok(editRun.prompt.includes(mark(editQuestion)))
   const editReceipt=await execute(edited.runId,editRun,editQuestion);assert.notEqual(editReceipt.answer,actual.answer)
   const input={operation:'rerun',anchorRunId:resultRun,anchorKey:actual.part,requestId:randomUUID()}
   const rerun=await versioned(ownerCookie,input);assert.ok(rerun.versionId&&rerun.runId!==edited.runId,JSON.stringify(rerun))
   assert.deepEqual(await versioned(ownerCookie,input),rerun)
   const retryRun=await getRun(rerun.runId);assert.equal(retryRun.continuesRunId,edited.runId);assert.equal(retryRun.model,model)
   const replay=await execute(rerun.runId,retryRun,steer)
   const request=async()=>{const res=await fetch(origin+'/mikka/api/rpc',{method:'POST',headers:{origin,cookie:ownerCookie,'content-type':'application/json','x-mikka-rpc':'1'},body:JSON.stringify({version:1,action:'agents.getThreadReplyVersions',args:[issueId,runId]})});const b=await res.json();assert.equal(b.ok,true,JSON.stringify(b));return b.result}
   const versions=await request();assert.deepEqual(versions.map(v=>v.resultRunId),[edited.runId,rerun.runId])
   assert.equal(versions[0].originalText,text);assert.equal(versions[0].output,editReceipt.answer);assert.equal(versions[1].originalText,actual.answer);assert.equal(versions[1].output,replay.answer)
   const count=async()=>(await independent.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1 AND "issueId"=$2',[owner,issueId])).rows[0].n
   const n=await count();assert.deepEqual(await request(),versions);assert.equal(await count(),n);assert.equal((await getRun(resultRun)).lastReply,actual.answer)
   note('two real immutable version branches with retained original output, owner-only admission and redisplay without dispatch',{denied:denied.error,parentOutput:actual.answer,edit:{id:edited.runId,version:edited.versionId,output:editReceipt.answer,model:editRun.model,session:editReceipt.thread},rerun:{id:rerun.runId,version:rerun.versionId,output:replay.answer,model:retryRun.model,session:replay.thread},totalRuns:n,view:versions})
  }
 }
 if(interrupt){
  const held=await queueRow(reqId)
  assert.equal(held.status,'failed');assert.equal(held.sentRunId,null);note('terminal cancelled attempt held the queued message and created no unauthorized continuation',{held})
  assert.ok(replacementAttempt)
  const query=async()=>(await independent.query('select a."runId" from factory_attempts a join factory_tasks t on t.id=a."taskId" where a.id=$1 and t."userId"=$2 and t."issueId"=$3 and t."workspaceId"=$4',[replacementAttempt,owner,issueId,ws.id])).rows[0]?.runId
  let replacementId=await query()
  for(let i=0;i<24&&!replacementId;i++){await wait(250);replacementId=await query()}
  assert.ok(replacementId&&replacementId!==runId,'The authorized replacement should be attached to its actual Factory attempt')
  const replacement=await getRun(replacementId)
  assert.equal(replacement.continuesRunId,runId);assert.equal(replacement.issueId,issueId);assert.equal(replacement.workspaceId,ws.id)
  assert.ok(replacement.prompt.includes(mark(replacementQuestion)));assert.ok(!replacement.prompt.includes(mark(steer)),'The held message must not enter the new model prompt')
  const offered=(await dcall(devicePath+'?wait=0')).queuedRuns??[];assert.ok(offered.includes(replacementId))
  const req=randomUUID(),forNew='New input for the replacement only.'
  assert.deepEqual(await rpc(ownerCookie,'sendIssueThreadReply',{runId:replacementId,text:forNew,delivery:'queue',requestId:req}),{sent:true,continued:false,runId:replacementId})
  assert.equal((await queueRow(req)).status,'queued')
  const answer=await execute(replacementId,replacement,replacementQuestion)
  assert.deepEqual(await queueRow(reqId),held)
  assert.equal((await queueRow(req)).status,'failed','The replacement ended its own turn without a submitted handoff')
  const visible=await threadDeliveryView(pool,owner,runId,replacementId)
  assert.ok(visible.queued.some(v=>v.id===held.id&&v.text===text&&v.status==='failed'))
  note('new authorized replacement ran its revised prompt and left earlier queued text visible without delivery',{replacementId,model:replacement.model,output:answer.answer,session:answer.thread,old:held,new:await queueRow(req)})
 }
 note('actual CPU result and completion persisted; event replay deduplicated',{model:provider,mode:handin?'afterRun':interrupt?'interrupt':'steer',modelText:transcript,terminal,chunks:rows.length,durable:stored,ownerMessageCopies:copies,cancelledQueue:(await queueRow(cancelledId)).status})
 trace.success=true;persist()
 writeFileSync(join(dir,handin?'after-run-result.json':interrupt?'interrupt-result.json':'steer-result.json'),JSON.stringify(trace,null,2),{mode:0o600})
}catch(e){
 trace.failure={name:e.name,message:String(e.message).replaceAll(process.env.E_LOOPBACK_KEY!,'[redacted]').slice(0,750),location:String(e.stack).split('\n').slice(1,5).join('\n').slice(0,800)};persist();process.exitCode=1
 }finally{
 const cleanup=(stage:string)=>appendFileSync(join(dir,'cleanup-'+(interrupt?'interrupt':handin?'after-run':'steer')+'.jsonl'),JSON.stringify({at:new Date().toISOString(),stage,resources:process.getActiveResourcesInfo().sort()})+'\n',{mode:0o600})
 cleanup('application assertions settled')
 if(!trace.success&&session&&!trace.stages.some((s:any)=>s.stage==='authentic MCP handoff before completion writer'))await session.cancel().catch(()=>{})
 if(http)await http.close()
 cleanup('native HTTP transport closed and H3 disposal work drained')
 await independent.end()
 const {builtinGateway}=await import('../../lib/builtin-gateway/runtime')
 await builtinGateway()?.stop()
 cleanup('test observer and builtin gateway stopped')
 const [{pool},{workspacePool}]=await Promise.all([import('../../lib/db'),import('../../lib/workspace-db')])
 await Promise.all([pool.end(),workspacePool.end()])
 cleanup('product app and workspace database clients stopped')
 const timer=setTimeout(()=>cleanup('independent twelve-second residual runtime observation'),12000)
 timer.unref()
}
