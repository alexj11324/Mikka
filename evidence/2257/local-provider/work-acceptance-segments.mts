import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import { createHash,randomUUID } from 'node:crypto'
import { appendFileSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs'
import { serve } from 'srvx/node'
import { join } from 'node:path'
import { Pool } from 'pg'
import { SOURCE_DAEMON_VERSION } from '@mikka/protocol/device'
import {MODEL_CREDENTIAL_HEADER,REPO_ORIGIN_HEADER} from '@mikka/protocol/device'
import {DAEMON_PROTOCOL_VERSION} from '@mikka/protocol/daemon'
import { CLIENT_VERSION_HEADER } from '@mikka/protocol/version'
import { normalizeRepository } from '@mikka/protocol/repository'
import { seedUser,seedWorkspace,seedIssue,seedBot } from '../../tests/support/workspace-admin-db'
import { ClaudeAdapter } from '../../packages/daemon/src/adapters/claude'
import { ToolApprovalGate } from '../../packages/daemon/src/agents/tool-approval'
import { buildChildEnv } from '../../packages/daemon/src/env'
import { createLogger } from '../../packages/daemon/src/log'

const dir=process.env.E_CODEX_QA!,origin=process.env.BETTER_AUTH_URL!
const model='SmolLM2-135M-Instruct-Q4_K_M'
const interrupt=false
const runId=randomUUID(),deviceId=randomUUID(),agentId=randomUUID(),repoId=randomUUID()
const handin=true
const trace:any={evaluation:'Two segments: real Agent dispatch, device/CLI report and independent SQL; fixture for the middle independent reviewer and approvals state, then real authenticated human acceptance and Work. No real automated reviewer or external PR produced.',source:process.env.E_RUN_SOURCE,runId,deviceId,cli:process.env.E_CODEX_VERSION,model,weightSha256:process.env.E_WEIGHT_SHA,cliSha256:process.env.E_CLI_BINARY_SHA,stages:[],scope:'Actual cookie-authenticated browser RPC and device REST over loopback HTTP. Only the bridge between returned device commands and the unmodified ClaudeAdapter is an explicit QA driver. Provider uses real GGUF inference and paced transport. No subscription or production release.'}
const persist=()=>writeFileSync(join(dir,'delivery.json'),JSON.stringify(trace,null,2),{mode:0o600})
const note=(stage:string,data:any={})=>{trace.stages.push({stage,at:new Date().toISOString(),...data});persist()}
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const mark=(s:string)=>'E2262_QA_BEGIN '+s+' E2262_QA_END'
const initial=true?'The user wants the finished report delivered. Choose submit, not answer. The report should say which color a clear daytime sky is.':'List twenty vegetables with a sentence about each.',steer='Name the capital of France in one short sentence.'
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
 const bot=await seedBot(independent,ws.id,owner,'Report desk')
 const brief='Assess the colour of a clear daytime sky for the team.'
 const {withTaskWorkspace}=await import('../../lib/task-workspace')
 const {db}=await import('../../lib/db')
 const {createIssueForUserInTransaction}=await import('../../lib/issue-create')
 const {userActor}=await import('../../lib/activity-actor')
 const created=await withTaskWorkspace(owner,ws.id,()=>db.transaction(tx=>createIssueForUserInTransaction(tx,owner,{title:'Daytime sky observation',content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:brief}]}]},priority:'normal',status:'todo'},userActor(owner),{workspaceId:ws.id})))
 assert.ok(created?.id);const issueId=created.id
 const remote='https://github.com/octo/fixture.git'
 await independent.query(`insert into devices(id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) values($1,$2,'Synthetic CI Linux','local','laptop',true,now(),$3)`,[deviceId,owner,JSON.stringify([{harness:'claude_code',installed:true,toolApproval:true}])])
 await independent.query(`insert into agents(id,"userId","deviceId",harness,name) values($1,$2,$3,'claude_code','Synthetic CPU model')`,[agentId,owner,deviceId])
 await independent.query(`insert into device_repos(id,"deviceId","userId","repoPath","remoteUrl") values($1,$2,$3,$4,$5)`,[repoId,deviceId,owner,normalizeRepository(remote).key,remote])
 const {acceptLocalRun}=await import('../../lib/run-admission-store')
 const prompt=mark(initial)
 const seedInput={id:runId,userId:owner,issueId,agentId,deviceId,deviceRepoId:repoId,botId:null,origin:'web',prompt,promptTaskStart:0,promptTaskLength:[...prompt].length,definition:{schemaVersion:1,kind:'worker',harness:'claude_code',instructions:'Use only the local model for this synthetic prompt.',definitionDigest:h('synthetic'),promptDigest:h(prompt),model,modelSource:'native-default',parent:null,readOnly:true} as never,dispatch:{issueId,agentId,deviceRepoId:repoId,requestKey:randomUUID()}}
 const {pool}=await import('../../lib/db')
 const {addApiKey}=await import('../../lib/model-api-keys')
 const savedKey=await addApiKey(pool,owner,{provider:'custom',name:'Isolated genuine CPU catalogue',baseUrl:'http://127.0.0.1:3858',protocol:'anthropic',apiKey:process.env.E_LOOPBACK_KEY!})
 assert.ok(savedKey.models.includes(model))
 note('repository-supported test catalogue verified the loaded model through authenticated local HTTP',{model,credentialType:'isolated synthetic',serverSaved:true})
 const {withProjectResourceLease}=await import('../../lib/project-resources/store')
 const {queueFactoryTask}=await import('../../lib/factory/task-dispatch')
 const admitted=await withProjectResourceLease(owner,ws.id,()=>queueFactoryTask(pool,owner,{issueId,botId:bot,ownerRequested:true,agentId,deviceRepoId:repoId,note:prompt,key:randomUUID(),queue:(tx,userId,req,botId,ctx)=>acceptLocalRun({...seedInput, userId,botId,factoryContext:ctx},tx)}))
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
  const res=await fetch(origin+'/mikka/v1/'+path,{method,headers:{authorization:'Bearer '+token,[CLIENT_VERSION_HEADER]:SOURCE_DAEMON_VERSION,[MODEL_CREDENTIAL_HEADER]:'1',[REPO_ORIGIN_HEADER]:'1','content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})})
  note('device REST response',{method,path:path.split('?')[0],status:res.status})
  if(res.status!==expected){const fail=await res.json().catch(()=>({}));throw Error(method+' '+path+' '+res.status+' '+String(fail.code??fail.error??''))}
  return expected===204?null:res.json()
 }

 const registration=await dcall('devices/register','POST',{deviceId,workspaceId:ws.id,name:'Isolated Linux evaluator',platform:'linux',arch:'x64',daemonVersion:SOURCE_DAEMON_VERSION,protocolVersion:DAEMON_PROTOCOL_VERSION,harnesses:[{harness:'claude_code',installed:true,version:process.env.E_CODEX_VERSION,models:[model],toolApproval:true}]})
 assert.equal(registration.deviceId,deviceId)
 const sourceDir=join(dir,'fixture','work'),work=join(dir,'fixture','report-execute'),reviewWork=join(dir,'fixture','report-review')
 const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim()
 const candidate=git(sourceDir,'rev-parse','HEAD')
 git(sourceDir,'worktree','add','--detach',work,candidate);git(sourceDir,'worktree','add','--detach',reviewWork,candidate)
 const {fixedCheckSnapshot}=await import('../../packages/daemon/src/runs/check')
 const {factoryCheckAssignment}=await import('../../lib/factory/checks')
 const {factoryBinding}=await import('../../lib/factory/dispatch')
 const getTask=async()=>(await independent.query('SELECT t.id,t."issueId",t."userId",t."workspaceId",t.stage,t.status,t."attemptId",t.revision,t."candidateId",a."runId",a.output FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id WHERE t."issueId"=$1 AND t."userId"=$2',[issueId,owner])).rows[0]
 const issue=async()=>(await independent.query(`SELECT i.status,i.content->'attrs'->'mikka'->'delegate' AS delegate FROM issues i WHERE i.id=$1 AND i."userId"=$2`,[issueId,owner])).rows[0]
 const actor=await issue();assert.deepEqual(actor.delegate,{id:agentId,name:'Synthetic CPU model',kind:'agent',image:null});assert.notEqual(actor.status,'done')
 const home=join(dir,'fixture','home'),stateDir=join(dir,'fixture','adapters');mkdirSync(stateDir,{recursive:true})
 const adapter=new ClaudeAdapter({stateDir,binary:process.env.E_CLI_BINARY!})
 const execute=async(id:string,cwd:string,marker:string,review=false)=>{
  const offered=(await dcall('devices/'+deviceId+'/commands?wait=0')).queuedRuns??[];assert.ok(offered.includes(id),'Device work did not offer the expected run')
  const claim=await dcall('devices/'+deviceId+'/runs/'+id+'/claim','POST')
  assert.equal(claim.runId,id);assert.equal(claim.deviceId,deviceId);assert.equal(claim.issueId,issueId);assert.equal(claim.harness,'claude_code')
  note('authenticated device claimed an exact admitted run',{runId:id,harness:claim.harness,stage:review?'review':'execute',serverModel:claim.model??null})
  const {rows:[record]}=await independent.query('SELECT id,"userId","workspaceId","issueId","agentId","deviceId",prompt,"agentDefinition" AS def FROM agent_runs WHERE id=$1',[id]);assert.equal(record.issueId,issueId);assert.equal(record.workspaceId,ws.id)
  const cmd=review?await factoryCheckAssignment(pool,owner,id):null
  if(cmd){assert.equal(cmd.factoryCheck.stage,'review');assert.equal(cmd.baseBranch,candidate);assert.equal(cmd.policy.readOnly,true)}
  const fixed=await fixedCheckSnapshot(sourceDir,cwd,candidate)
  const actual=review ? record.prompt+'\n'+mark(marker) : record.prompt
  const opts={runId:id,cwd,prompt:actual,model,kind:review?'acceptance':'implement',...(cmd?{policy:cmd.policy,factoryCheck:cmd.factoryCheck}:{}),log:createLogger({level:'silent'}),env:buildChildEnv({host:{PATH:process.env.PATH,HOME:home,SSL_CERT_FILE:join(dir,'ephemeral-ca.pem'),NODE_EXTRA_CA_CERTS:join(dir,'ephemeral-ca.pem'),LANG:'C.UTF-8'},runId:id}),credential:{kind:'provider',protocol:'anthropic',baseUrl:'https://127.0.0.1:3857',key:process.env.E_LOOPBACK_KEY!},toolApproval:new ToolApprovalGate(id,{isLive:()=>true})}
  session=await adapter.start(opts as any)
  await dcall('runs/'+id,'PATCH',{state:'running',sessionId:session.sessionId},204)
  let terminal:any;const chunks:any[]=[]
  for await(const e of session.events()){if(e.type==='exit')terminal=e;else if(e.type==='chunk')chunks.push(e.chunk)}
  assert.equal(terminal?.outcome,'succeeded');assert.equal(terminal.stopReason,'submitted');assert.ok(terminal.report.summary)
  assert.deepEqual(await fixedCheckSnapshot(sourceDir,cwd,candidate),fixed)
  const observed=readFileSync(join(dir,'decisions.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).some(row=>row.prompt===marker&&JSON.parse(row.generated).summary===terminal.report.summary)
  assert.ok(observed,'The real model summary must equal the MCP handoff')
  const report={...terminal.report,sourceCommit:fixed.sha,filesChanged:[],verify:{status:'not_run'},...(review?{check:{sha:fixed.sha,readOnly:true}}:{})}
  if(review){assert.ok(report.criteria?.length,'Reviewer tool must provide its own criterion and evidence')}
  if(chunks.length)await dcall('runs/'+id+'/events','POST',{fromSeq:1,chunks})
  if(!review){
    const { chromium }=await import('@playwright/test')
    const { pathToFileURL }=await import('node:url')
    const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    // This is the real report the CLI just handed in, rendered from a local report file.
    // It is the producer's visual evidence, not a screenshot of the Task client or of an external site.
    const localReport=join(dir,'fixture','producer-delivery.html')
    writeFileSync(localReport,'<!doctype html><meta charset=utf-8><title>Daytime sky observation</title><main><h1>Daytime sky observation</h1><p>'+escape(brief)+'</p><article>'+escape(terminal.report.summary)+'</article></main>')
    const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',chromiumSandbox:true,headless:true})
    let bytes:Buffer
    try{const page=await browser.newPage({viewport:{width:800,height:420}});await page.goto(pathToFileURL(localReport).href);assert.equal(await page.locator('article').innerText(),terminal.report.summary);bytes=await page.screenshot({type:'png'})}
    finally{await browser.close()}
    const digest=createHash('sha256').update(bytes).digest('hex'),base='runs/'+id+'/captures'
    const opened=await dcall(base,'POST',{title:'Submitted report shown in Chromium',contentType:'image/png',size:bytes.length,sha256:digest},201)
    assert.equal(opened.upload.target,'server')
    const sent=await fetch(origin+'/mikka/v1/'+base+'/'+opened.captureId,{method:'PUT',body:bytes,headers:{authorization:'Bearer '+token,[CLIENT_VERSION_HEADER]:SOURCE_DAEMON_VERSION,'content-type':'image/png'}})
    assert.equal(sent.status,204)
    const stored=await dcall(base+'/'+opened.captureId+'/complete','POST',{})
    assert.equal(stored.capture.id,opened.captureId)
    const {rows:[facts]}=await independent.query(`SELECT status,sha256,size,"runId","userId","inlineContent" AS content FROM run_captures WHERE id=$1`,[opened.captureId])
    assert.equal(facts.status,'ready');assert.equal(facts.sha256,digest);assert.equal(createHash('sha256').update(facts.content).digest('hex'),digest);assert.equal(Number(facts.size),bytes.length);assert.equal(facts.runId,id);assert.equal(facts.userId,owner)
    note('genuine producer Chromium PNG submitted via canonical run capture REST before daemon completion',{runId:id,captureId:opened.captureId,sha256:digest,bytes:bytes.length,storedStatus:facts.status,content:'The actual native MCP report rendered from a local report file'})
  }
  await dcall('runs/'+id+'/complete','POST',{stopReason:terminal.stopReason,report},204)
  const {rows:[saved]}=await independent.query('SELECT status,"stopReason",report,"sessionId" FROM agent_runs WHERE id=$1',[id])
  assert.equal(saved.status,'succeeded');assert.equal(saved.report.summary,terminal.report.summary)
  note('real native MCP report and clean fixed candidate persisted',{id,stage:review?'review':'execute',native:saved.sessionId,model,actualModelReport:saved.report.summary,criteria:saved.report.criteria??null,fixed,status:saved.status})
  return saved
 }
 const humanApi=async(cookie:string,path:string,payload?:unknown)=>{const res=await fetch(origin+'/mikka/api/'+path,{method:payload?'POST':'GET',headers:{cookie,origin,'content-type':'application/json','x-mikka-rpc':'1','sec-fetch-site':'same-origin'},...(payload?{body:JSON.stringify(payload)}:{})});let body:any;try{body=await res.json()}catch{body=null}return {status:res.status,body}}
 const task=(await getTask());note('explicit owner dispatch initializes selected agent',{issueId,workspace:ws.id,bot,agentId,runId,taskId:task.id,delegate:actor.delegate,status:actor.status})
 const producer=await execute(runId,work,initial)


 const prior=await getTask()
 note('independent Factory state after canonical producer completion',{stage:prior.stage,status:prior.status,candidate:prior.candidateId,output:prior.output})
 assert.equal(prior.stage,'review');assert.equal(prior.status,'running');assert.ok(prior.runId&&prior.candidateId&&prior.runId!==runId)
 note('producer receipt created a real candidate and allocated its independent reviewer',{taskId:prior.id,producer:runId,candidateId:prior.candidateId,reviewRunId:prior.runId,sourceSha:candidate,issueStatus:(await issue()).status,delegate:(await issue()).delegate})
 const {rows:[actualCandidate]}=await independent.query('SELECT id,sha,kind,"runId",repository,environment FROM factory_candidates WHERE id=$1 AND "taskId"=$2',[prior.candidateId,prior.id])
 assert.deepEqual([actualCandidate.sha,actualCandidate.kind,actualCandidate.runId],[candidate,'report',runId])
 const fixtureSession='fixture-independent-'+randomUUID()
 const reviewSummary='Synthetic independent review from the existing test fixture. No natural-language reviewer executed in this segment.'
 const reviewReport={summary:reviewSummary,sourceCommit:candidate,filesChanged:[],verify:{status:'not_run'},check:{sha:candidate,readOnly:true},reviewVerdict:'needs_judgment',criteria:[{text:'Independent review receipt fixture',passed:false,status:'unverified',reason:'This fixture does not execute the reviewer model.'}]}
 // Only the terminal report follows lib/factory/checks.db.test.ts. The producer, candidate,
 // reviewer allocation, gate evaluation, human approval and detail reads use the product.
 const update=await independent.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,"startedAt"=now(),"finishedAt"=now(),report=$3 WHERE id=$1 AND "userId"=$4 AND "workspaceId"=$5 AND "issueId"=$6 AND kind='acceptance' AND status='queued' RETURNING id`,[prior.runId,fixtureSession,reviewReport,owner,ws.id,issueId]);assert.equal(update.rowCount,1)
 note('declared fixture ends the exact independent reviewer assigned by the product',{source:'lib/factory/checks.db.test.ts terminal()+report human acceptance; no real reviewer',fixtureRunId:prior.runId,fixtureSession,actualCandidate,producerSession:producer.sessionId})
 const {reconcileFactoryAfterCompletion}=await import('../../lib/run-completion-effects')
 await reconcileFactoryAfterCompletion(pool,owner,prior.runId)
 const check={runId:prior.runId}
 const ready=await getTask();note('declared fixture and business state before genuine human acceptance',{ready,issue:await issue()});assert.equal(ready.stage,'approval');assert.notEqual((await issue()).status,'done')
 const action={operation:'accept',input:{binding:factoryBinding(ready),eventId:randomUUID()}}
 const path='factory/tasks/'+ready.id+'/approval'
 const refused=await humanApi(memberCookie,path,action);assert.ok([403,404].includes(refused.status),JSON.stringify(refused))
 assert.equal((await independent.query('select 1 from factory_deliverable_acceptances where "taskId"=$1',[ready.id])).rowCount,0)
 const accepted=await humanApi(ownerCookie,path,action);assert.equal(accepted.status,200,JSON.stringify(accepted));assert.equal(accepted.body.status,'accepted')
 assert.deepEqual(await humanApi(ownerCookie,path,action),accepted)
 assert.equal((await issue()).status,'done')
 const {rows:receipts}=await independent.query('select a.id,a."userId" AS owner,a."candidateId" AS candidate,s."userId" AS human from factory_deliverable_acceptances a JOIN session s ON s.id=a."sessionId" where a."taskId"=$1',[ready.id]);assert.equal(receipts.length,1);assert.equal(receipts[0].owner,owner);assert.equal(receipts[0].human,owner);assert.equal(receipts[0].candidate,ready.candidateId)
 const detail=await humanApi(ownerCookie,'mobile/tasks/'+issueId+'?work=1');assert.equal(detail.status,200,JSON.stringify(detail));const data=detail.body
 note('canonical authorized task detail',{task:data.task,work:data.work,timeline:data.timeline,activity:data.activity,receipts,memberDenial:refused})
 assert.equal(data.task.workOwner.kind,'agent');assert.equal(data.task.workOwner.name,'Synthetic CPU model');assert.equal(data.task.status,'done');assert.equal(data.task.group,'done');assert.equal(data.task.state,'done');assert.equal(data.task.description,brief)
 assert.ok(data.work.conversations.some((c:any)=>c.id===runId||c.id===check.runId));assert.ok(Array.isArray(data.work.pullRequests));assert.equal(data.work.pullRequests.length,0,'Report-only candidate does not imply an external PR')

 const history=data.timeline.filter((fact:any)=>fact.kind==='history').map((fact:any)=>fact.event)
 assert.ok(history.length);assert.ok(history.some((e:any)=>e.kind==='assigned'&&e.assignmentTarget==='delegate'),'History must include the independently recorded agent assignment')
 assert.ok(!history.some((e:any)=>['stage','execute','review','verify','approval','monitor'].includes(e.kind)),'Persisted task history must not enumerate Factory stages')
 const {rows:stageSources}=await independent.query(
   'SELECT "taskId" AS "threadId","commentId" AS "messageId",stage FROM factory_stage_updates WHERE "taskId"=$1 ORDER BY stage',[ready.id])
 assert.deepEqual(stageSources.map(s=>s.stage),['completed','handoff','implement','review'])
 const stageKeys=new Set(stageSources.map(s=>s.threadId+':'+s.messageId))
 const publicFacts=data.timeline.filter((fact:any)=>fact.kind!=='history')
 const stagedInHumanActivity=publicFacts.filter((fact:any)=>stageKeys.has(fact.threadId+':'+fact.messageId))
 note('persisted Factory stage receipts versus human Activity',{sourceStageCount:stageSources.length,stages:stageSources,publicFactCount:publicFacts.length,stagedInHumanActivity})
 const expectedStages=[...stageKeys].sort()
 assert.deepEqual(stagedInHumanActivity.map((f:any)=>f.threadId+':'+f.messageId).sort(),expectedStages,'Each persisted Bot progress comment appears exactly once in Activity')
 for(const fact of stagedInHumanActivity){assert.equal(fact.kind,'comment');assert.equal(fact.actor,'bot');assert.ok(fact.author?.trim());assert.ok(fact.body?.trim())}
 const legacyDetail=await humanApi(ownerCookie,'mobile/tasks/'+issueId)
 assert.equal(legacyDetail.status,200)
 assert.deepEqual(legacyDetail.body.timeline.filter((fact:any)=>fact.threadId&&stageKeys.has(fact.threadId+':'+fact.messageId)),stagedInHumanActivity)
 const memberDetail=await humanApi(memberCookie,'mobile/tasks/'+issueId+'?work=1')
 if(memberDetail.status===200){assert.equal(memberDetail.body.task.id,issueId);assert.ok(Array.isArray(memberDetail.body.work.conversations))}else assert.equal(memberDetail.status,404)
 const link='https://github.com/alexj11324/Mikka/pull/2364'
 const revision=(await independent.query('select revision from issues where id=$1',[issueId])).rows[0].revision
 const manual=await humanApi(ownerCookie,'rpc',{version:1,action:'issue-metadata.updateIssueMetadata',args:[{id:issueId,revision,patch:{pullRequests:[{url:link,state:'open',title:'Existing E integration reference'}]}}]})
 assert.equal(manual.status,200);assert.equal(manual.body.ok,true,JSON.stringify(manual.body?.error));assert.ok(manual.body.result?.issue?.id===issueId,manual.body.result?.error)
 const checked=await humanApi(ownerCookie,'mobile/tasks/'+issueId+'?work=1');assert.equal(checked.status,200)
 assert.ok(checked.body.work.pullRequests.some((pull:any)=>pull.url===link));assert.equal(checked.body.task.status,'done')
 assert.equal(checked.body.task.workOwner.name,'Synthetic CPU model')
 note('human history, authorized Work and an expressly attached existing PR, independent of report acceptance',{kinds:history.map((event:any)=>event.kind),memberDetailStatus:memberDetail.status,conversationIds:checked.body.work.conversations.map((c:any)=>c.id),manuallyLinked:link,producedPullRequest:false})
 trace.success=true;persist()

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
