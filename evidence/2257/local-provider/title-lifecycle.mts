import assert from 'node:assert/strict'
import { createHash,randomUUID } from 'node:crypto'
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Pool } from 'pg'
import { ACTIVE_TURN_STEER_HEADER,SOURCE_DAEMON_VERSION } from '@mikka/protocol/device'
import { CLIENT_VERSION_HEADER } from '@mikka/protocol/version'
import { normalizeRepository } from '@mikka/protocol/repository'
import { seedUser,seedWorkspace,seedIssue } from '../../tests/support/workspace-admin-db'
import { CodexAdapter } from '../../packages/daemon/src/adapters/codex'
import { NoSandbox } from '../../packages/daemon/src/agents/sandbox'
import { ToolApprovalGate } from '../../packages/daemon/src/agents/tool-approval'
import { buildChildEnv } from '../../packages/daemon/src/env'
import { createLogger } from '../../packages/daemon/src/log'

const dir=process.env.E_CODEX_QA!,origin=process.env.BETTER_AUTH_URL!
const model='SmolLM2-135M-Instruct-Q4_K_M'
const interrupt=process.env.E_FACTORY_INTERRUPT==='1'
const runId=randomUUID(),deviceId=randomUUID(),agentId=randomUUID(),repoId=randomUUID()
const handin=true
const trace:any={source:process.env.E_RUN_SOURCE,runId,deviceId,cli:process.env.E_CODEX_VERSION,model,weightSha256:process.env.E_WEIGHT_SHA,cliSha256:process.env.E_CLI_BINARY_SHA,stages:[],scope:'Original #2265 on isolated PG17. Synthetic owner/member, real HTTPS official Codex + actual MCP handoff, device completion and GGUF-backed automatic creation/terminal titles. A QA driver bridges the device poll to the unchanged official adapter. No customer data, subscription, private overlay or publication.'}
const persist=()=>writeFileSync(join(dir,'title-lifecycle.json'),JSON.stringify(trace,null,2),{mode:0o600})
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
 http=createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk)
   const request=new Request(origin+req.url,{method:req.method,headers:req.headers as Record<string,string>,...(chunks.length?{body:Buffer.concat(chunks)}:{})})
   const result=await api.fetch(request);res.statusCode=result.status
   for(const [k,v] of result.headers)res.setHeader(k,v)
   res.end(Buffer.from(await result.arrayBuffer()))
  }catch{res.writeHead(500);res.end()}
 })
 await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(3859,'127.0.0.1',resolve)})
 const owner=await seedUser(independent,'e-owner'),member=await seedUser(independent,'e-member')
 const ws=await seedWorkspace(independent,owner,[{userId:owner,role:'admin'},{userId:member,role:'member'}])
 const issueId=await seedIssue(independent,owner,ws.id,{registered:true})
 await independent.query('UPDATE issues SET content=$2 WHERE id=$1',[issueId,{type:'doc',attrs:{mikka:{number:1}}}])
 const remote='https://github.com/octo/fixture.git'
 await independent.query(`insert into devices(id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) values($1,$2,'Synthetic CI Linux','local','laptop',true,now(),$3)`,[deviceId,owner,JSON.stringify([{harness:'codex',installed:true,toolApproval:true,activeTurnSteer:true}])])
 await independent.query(`insert into agents(id,"userId","deviceId",harness,name) values($1,$2,$3,'codex','Synthetic CPU model')`,[agentId,owner,deviceId])
 await independent.query(`insert into device_repos(id,"deviceId","userId","repoPath","remoteUrl") values($1,$2,$3,$4,$5)`,[repoId,deviceId,owner,normalizeRepository(remote).key,remote])
 const {acceptLocalRun}=await import('../../lib/run-admission-store')
 const task='Prepare a clear daytime sky report.'
 const prompt=task+'\n'+mark(initial)
 const seedInput={id:runId,userId:owner,issueId,agentId,deviceId,deviceRepoId:repoId,botId:null,origin:'web',prompt,promptTaskStart:0,promptTaskLength:[...task].length,definition:{schemaVersion:1,kind:'worker',harness:'codex',instructions:'Use only the local model for this synthetic prompt.',definitionDigest:h('synthetic'),promptDigest:h(prompt),model,modelSource:'native-default',parent:null,readOnly:true} as never,dispatch:{issueId,agentId,deviceRepoId:repoId,requestKey:randomUUID()}}
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
 const get=async()=> (await independent.query(`SELECT r.id,r."issueId",r."workspaceId",r."sessionId",r."finishedAt",r."updatedAt",r.status,r.title,r."titleSource",r.report->>'summary' AS summary, i.title AS "taskTitle" FROM agent_runs r JOIN issues i ON i.id=r."issueId" WHERE r.id=$1 AND r."userId"=$2`,[runId,owner])).rows[0]
 const file=join(dir,'inference.jsonl')
 const allTitles=()=>existsSync(file)?readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[]
 const snapshot=async(label:string,calls:number)=>{
  const {parseShortTitle}=await import('../../lib/short-title')
  const end=Date.now()+30000
  while(Date.now()<end){
   const row=await get(), infer=allTitles()
   if(row && infer.length===calls && row.titleSource==='generated' && row.title===parseShortTitle(infer[calls-1].output,false)){
    assert.ok(infer[calls-1].outputTokens>0);assert.equal(row.issueId,issueId);assert.equal(row.workspaceId,ws.id);assert.notEqual(runId,issueId)
    note(label,{row,inference:infer[calls-1]});return row
   }
   await wait(150)
  }
  throw Error('Title did not match independent persisted inference '+label+' count='+allTitles().length+' source='+(await get())?.titleSource)
 }
 const created=await snapshot('created title accepted by independent SQL',1)
 const offered=await dcall('devices/'+deviceId+'/commands?wait=0')
 assert.ok(offered.queuedRuns?.includes(runId),'Canonical admitted run must be offered by the real device service')
 const root=join(dir,'fixture'),cwd=join(root,'work'),home=join(root,'home'),stateDir=join(root,'adapters')
 mkdirSync(stateDir,{recursive:true})
 const adapter=new CodexAdapter({stateDir,binary:process.env.E_CLI_BINARY!,sandbox:new NoSandbox()})
 session=await adapter.start({runId,cwd,prompt,model,log:createLogger({level:'silent'}),env:buildChildEnv({host:{PATH:process.env.PATH,HOME:home,SSL_CERT_FILE:join(dir,'ephemeral-ca.pem'),LANG:'C.UTF-8'},runId}),credential:{kind:'provider',protocol:'openai',baseUrl:'https://127.0.0.1:3857/v1',key:process.env.E_LOOPBACK_KEY!},toolApproval:new ToolApprovalGate(runId,{isLive:()=>true})})
 await dcall('runs/'+runId,'PATCH',{state:'running',sessionId:session.sessionId},204)
 const chunks:any[]=[];let terminal:any
 for await(const event of session.events()){if(event.type==='chunk')chunks.push(event.chunk);else if(event.type==='exit')terminal=event}
 assert.equal(terminal?.outcome,'succeeded');assert.equal(terminal.stopReason,'submitted')
 const decisions=readFileSync(join(dir,'decisions.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s))
 const actual=decisions.find(x=>{const v=JSON.parse(x.generated);return v.action==='submit' && v.summary===terminal.report.summary})
 assert.ok(actual && actual.generatedTokens>0)
 assert.ok(chunks.length && chunks.some(c=>c.type==='tool-input-available'))
 note('official native CLI handed in its actual model-generated summary',{terminal,decision:actual,session:session.sessionId,chunkCount:chunks.length})
 const eventBatch={fromSeq:1,chunks}
 assert.deepEqual(await dcall('runs/'+runId+'/events','POST',eventBatch),await dcall('runs/'+runId+'/events','POST',eventBatch))
 const completion={stopReason:terminal.stopReason,report:{...terminal.report,filesChanged:[],verify:{status:'not_run'}}}
 await dcall('runs/'+runId+'/complete','POST',completion,204)
 const ended=await snapshot('first terminal regenerated through actual final device REST and independent SQL',2)
 assert.equal(ended.status,'succeeded');assert.ok(ended.finishedAt);assert.equal(ended.sessionId,session.sessionId)
 assert.equal(ended.summary,terminal.report.summary);assert.equal(ended.taskTitle,created.taskTitle)
 assert.equal(allTitles()[1].syntheticTask.text,terminal.report.summary)
 const titleRpc=async(cookie:string,action:string,args:any[])=>{
  const res=await fetch(origin+'/mikka/api/rpc',{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-mikka-rpc':'1','sec-fetch-site':'same-origin'},body:JSON.stringify({version:1,action:'task-runs.'+action,args})})
  const body=await res.json();assert.equal(res.status,200,JSON.stringify(body));assert.equal(body.ok,true,JSON.stringify(body));return body.result
 }
 const denied=await titleRpc(memberCookie,'renameConversation',[runId,'Unauthorised title'])
 assert.equal(denied.error,'runNotFound');assert.equal((await get()).title,ended.title)
 const manual='Owner sky report';assert.deepEqual(await titleRpc(ownerCookie,'renameConversation',[runId,manual]),{title:manual})
 await dcall('runs/'+runId+'/complete','POST',completion,204)
 const kept=await get();assert.equal(kept.title,manual);assert.equal(kept.titleSource,'manual');assert.equal(allTitles().length,2)
 note('member denied, owner manual title survives replay',{denied,kept})
 const regen=await titleRpc(ownerCookie,'regenerateConversationTitle',[runId]);assert.equal(regen.regenerated,true)
 const regenerated=await snapshot('explicit authenticated owner regeneration persisted',3);assert.equal(regenerated.title,regen.title)
 trace.success=true;persist()
} catch(e){trace.failure={name:e.name,message:String(e.message).replaceAll(process.env.E_LOOPBACK_KEY!,'[redacted]').slice(0,750),location:String(e.stack).split('\n').slice(1,4).join('\n')};persist();process.exitCode=1}
finally{
 await independent.end()
 if(http)await new Promise<void>(resolve=>http.close(()=>resolve()))
 try{const {builtinGateway}=await import('../../lib/builtin-gateway/runtime');await builtinGateway()?.stop()}catch{}
 const [{pool},{workspacePool}]=await Promise.all([import('../../lib/db'),import('../../lib/workspace-db')]);await Promise.allSettled([pool.end(),workspacePool.end()])
}
