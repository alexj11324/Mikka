// Actual authenticated Next/Workflow SDK: synthetic cross-workspace prompt
// markers only. No real user content, provider, organization, or external writes.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {createHmac,randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {Pool} from 'pg'
import {start} from 'workflow/api'
import {CoordinatorInbox,isolatedInboxOptions} from '../lib/coordinator/wake-test-helpers.ts'
import {DECISIONS_URL} from '../lib/coordinator/decision.ts'
import {resourceFixture,isolatedResourceUrls} from '../lib/resources/test-fixtures.ts'
import {coordinatorRoute} from '../lib/policy/model.ts'
import {COORDINATOR_MODEL} from '../lib/coordinator/model.ts'
const urls=isolatedResourceUrls(),origin='http://127.0.0.1:3180',source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),compiledSource=readFileSync('.next/resource-source-sha','utf8').trim(),baseline=process.env.RESOURCE_POLICY_BASELINE==='1'
if(process.env.CI!=='true'||process.env.WORKFLOW_TARGET_WORLD!=='local'||process.env.WORKFLOW_LOCAL_BASE_URL!==origin+'/mikka'||!['/workspace/176-private-evidence/','/tmp/mikka-resource-176-'].some(p=>process.env.WORKFLOW_LOCAL_DATA_DIR?.startsWith(p))||['VERCEL','AI_GATEWAY_API_KEY','DECISION_GATEWAY_API_KEY','OPENCODE_API_KEY','OPENAI_API_KEY','COMPOSIO_API_KEY','FIRECRAWL_API_KEY','TELEGRAM_BOT_TOKEN'].some(k=>process.env[k]))throw Error('isolated keyless policy SDK only')
if(!baseline)assert.equal(compiledSource,source)
const app=new Pool({connectionString:urls.app}),workspace=new Pool({connectionString:urls.workspace}),plans=new Map(),observed=new Map(),runs=[]
const markers={history:'SYNTHETIC_WORKSPACE_A_HISTORY',summary:'SYNTHETIC_WORKSPACE_A_SUMMARY',memory:'SYNTHETIC_WORKSPACE_A_MEMORY'}
const log=x=>console.log(JSON.stringify({at:new Date().toISOString(),source,compiledSource,baseline,...x}))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function wait(fn,label){const end=Date.now()+45000;while(Date.now()<end){if(await fn())return;await sleep(100)}throw Error('timeout '+label)}
const server=createServer(async(req,res)=>{
 try{
  let text='';for await(const d of req)text+=d
  const id=req.headers['x-controlled-operation-id']
  let plan=plans.get(id)
  if(!plan){const row=(await app.query('SELECT "userId" FROM coordinator_events WHERE id=$1',[id])).rows[0];plan=plans.get(row?.userId);assert.ok(plan);plans.set(id,plan)}
  const prior=observed.get(id)??{requests:0,webRequests:0,decisionRequests:0,history:false,summary:false,memory:false}
  if(req.url==='/v2/scrape'||req.headers['x-controlled-logical-endpoint']===DECISIONS_URL){
   assert.ok(plan.issueId,'only explicitly registered synthetic issue withdrawal')
   const decision=req.headers['x-controlled-logical-endpoint']===DECISIONS_URL
   if(decision)prior.decisionRequests++;else prior.webRequests++
   observed.set(id,prior)
   // The actual provider has completed its synthetic work. Revoke the local
   // issue before returning 200, forcing the production commit fence to refuse.
   await app.query('UPDATE issues SET content=$2 WHERE id=$1',[plan.issueId,{type:'doc',attrs:{mikka:{deletedAt:new Date().toISOString()}},content:[]}])
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(decision?{answers:[{type:'predicate',name:'needsPerson',probability:0.9}]}:{success:true,data:{markdown:'CONTROLLED consumed web work; must not publish after local withdrawal',metadata:{statusCode:200,sourceURL:JSON.parse(text).url,url:JSON.parse(text).url}}}));return
  }
  assert.equal(req.url,'/model')
  const row=prior;row.requests++
  if(plan.issueId){
   assert.equal(row.requests,1);observed.set(id,row)
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({content:[{type:'tool-call',toolCallId:'controlled-revoked-page',toolName:'read_webpage',input:JSON.stringify({url:'https://fixture.public.example.org/revoked/'+plan.issueId})}],finishReason:{unified:'tool-calls',raw:'tool_calls'},usage:{inputTokens:{total:2,noCache:2,cacheRead:0,cacheWrite:0},outputTokens:{total:2,text:2,reasoning:0}},warnings:[]}));return
  }
  for(const key of Object.keys(markers))row[key]||=text.includes(markers[key]);observed.set(id,row)
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({content:[{type:'text',text:'CONTROLLED policy admission response'}],finishReason:{unified:'stop',raw:'stop'},usage:{inputTokens:{total:2,noCache:2,cacheRead:0,cacheWrite:0},outputTokens:{total:2,text:2,reasoning:0}},warnings:[]}))
 }catch(error){console.error('synthetic policy transport rejected:',error.message);res.writeHead(500).end('{}')}
})
server.listen(6183,'127.0.0.1');await once(server,'listening')
async function fixture({managedB=true,denyA=true,suspended=false,seed='all',second=true}={}){
 const route=coordinatorRoute(COORDINATOR_MODEL),f=await resourceFixture(app,workspace,[route],managedB)
 let a
 if(second){
  a=randomUUID();await workspace.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'synthetic policy A\')',[a,f.owner]);await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,\'admin\')',[a,f.owner,`${f.owner}@example.invalid`])
  await f.policy.publish(a,f.owner,0,{...f.document,layers:[{...f.document.layers[0],id:a,models:denyA?[]:[route]}]})
  if(suspended)await workspace.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[a,f.owner])
 }
 await app.query('INSERT INTO coordinator_sessions("userId",summary,memory) VALUES($1,$2,$3)',[f.owner,['all','summary'].includes(seed)?markers.summary:null,['all','memory'].includes(seed)?markers.memory:''])
 if(['all','history'].includes(seed))await app.query('INSERT INTO coordinator_messages(id,"userId",position,message) VALUES($1,$2,1,$3)',[randomUUID(),f.owner,{role:'user',content:markers.history}])
 const token=randomUUID();await app.query('INSERT INTO session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',[randomUUID(),token,f.owner]);const cookie=`better-auth.session_token=${encodeURIComponent(token+'.'+createHmac('sha256','isolated-resource-proof-no-production-authorization-123456789').update(token).digest('base64'))}`
 plans.set(f.owner,{})
 const response=await fetch(origin+'/mikka/api/coordinator/messages',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({submissionId:randomUUID(),workspaceId:f.workspaceId,text:'Return only the controlled policy acceptance response.'})})
 assert.equal(response.status,202);const id=(await response.json()).sourceEventId
 await wait(async()=>{const e=(await app.query('SELECT wake_status,wake_error FROM coordinator_events WHERE id=$1',[id])).rows[0];return e?.wake_error==='wakeAdmissionDeferred'||['completed','failed','cancelled'].includes(e?.wake_status)},'actual trusted B request terminal/deferred')
 const event=(await app.query('SELECT wake_status,wake_error,wake_workspace_id FROM coordinator_events WHERE id=$1',[id])).rows[0],quota=(await app.query('SELECT workspace_id,resource,state,settled_units FROM quota_reservations WHERE owner_id=$1',[f.owner])).rows,calls=observed.get(id)??{requests:0,history:false,summary:false,memory:false}
 assert.equal(event.wake_workspace_id,f.workspaceId)
 return {...f,a,id,event,quota,calls}
}
try{
 await wait(async()=>{try{return(await fetch(origin+'/mikka/api/auth/get-session')).status===200}catch{return false}},'Next ready')
 for(const managedB of [true,false]){
  const f=await fixture({managedB})
  if(baseline){assert.equal(f.event.wake_status,'completed');assert.equal(f.calls.requests,1);assert.ok(f.calls.history&&f.calls.summary&&f.calls.memory);assert.equal(f.quota.length,1)}
  else{assert.equal(f.event.wake_error,'wakeAdmissionDeferred');assert.equal(f.calls.requests,0);assert.equal(f.quota.length,0)}
  log({phase:baseline?'REPRODUCED selected B sends synthetic A history+summary+memory despite A route denial':'A-deny/B-selected refuses shared prompt before actual provider/quota',managedB,eventId:f.id,workspaceB:f.workspaceId,workspaceA:f.a,event:f.event,observed:f.calls,quota:f.quota})
 }
 if(!baseline){
  for(const seed of ['summary','memory','history']){
   const f=await fixture({managedB:false,seed});assert.equal(f.event.wake_error,'wakeAdmissionDeferred');assert.equal(f.calls.requests,0);assert.equal(f.quota.length,0)
   log({phase:'legacy unscoped context representation cannot bypass A policy',seed,eventId:f.id,requests:0})
  }
  const removed=await fixture({managedB:false,denyA:false,suspended:true,seed:'memory'});assert.equal(removed.event.wake_error,'wakeAdmissionDeferred');assert.equal(removed.calls.requests,0);assert.equal(removed.quota.length,0)
  log({phase:'retained managed A suspension cannot drop its global memory policy dependency',eventId:removed.id,requests:0})
  for(const second of [true,false]){
   const f=await fixture({denyA:false,managedB:false,second});assert.equal(f.event.wake_status,'completed');assert.equal(f.calls.requests,1);assert.ok(f.calls.history&&f.calls.summary&&f.calls.memory)
   assert.deepEqual(f.quota,[{workspace_id:f.workspaceId,resource:'coordinator.model',state:'settled',settled_units:'2'}])
   log({phase:'legitimate shared-context admission retains global context and charges only captured B',secondWorkspace:second,eventId:f.id,observed:f.calls,quota:f.quota})
  }
 }
 if(!baseline){
  for(const decision of [false,true]){
   const f=await resourceFixture(app,workspace,[],false),issueId=randomUUID(),id=randomUUID()
   await app.query('INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,\'SYNTHETIC local withdrawal fixture\',$3,\'todo\',\'normal\')',[issueId,f.owner,{type:'doc',content:[]}])
   plans.set(id,{issueId})
   await app.query('INSERT INTO coordinator_events(id,"userId",kind,"issueId","dedupeKey",payload,tier,wake_workspace_id,wake_next_at) VALUES($1,$2,$3,$4,$1::text,$5,$6,$7,clock_timestamp()-interval \'1 second\')',[id,f.owner,decision?'run_report':'user_message',issueId,{text:'Controlled provider success followed by local source withdrawal',workspaceId:f.workspaceId},decision?null:'attention',f.workspaceId])
   let run
   if(decision){
    assert.ok(process.env.CRON_SECRET,'only the disposable CI runtime sweep token')
    const response=await fetch(origin+'/mikka/api/cron/runtime',{headers:{authorization:'Bearer '+process.env.CRON_SECRET}})
    assert.equal(response.status,200)
   }else{
    const inbox=new CoordinatorInbox(app,{...isolatedInboxOptions(app,workspace,()=>new Date()),deliveryLeaseMs:60000,leaseMs:120000}),claim=await inbox.claim(f.owner);assert.ok(claim&&'delivery'in claim)
    const entry=JSON.parse(readFileSync('.next/diagnostics/workflows-manifest.json')).workflows['workflows/coordinator/workflow.ts'].coordinatorTurn
    run=await start({workflowId:entry.workflowId},[f.owner,claim.delivery]);runs.push(run)
   }
   const resource=decision?'gateway.decision':'web.scrape'
   await wait(async()=>(await app.query('SELECT state FROM quota_reservations WHERE owner_id=$1 AND resource=$2',[f.owner,resource])).rows[0]?.state==='uncertain','HTTP 200 followed by actual local issue 403 keeps full uncertain quota')
   if(run)await wait(async()=>['completed','failed','cancelled'].includes(await run.status),'withdrawn source formal workflow terminal')
   const quota=(await app.query('SELECT resource,state,settled_units FROM quota_reservations WHERE owner_id=$1 ORDER BY created_at',[f.owner])).rows
   const expectedUnits=decision?'2':'1'
   assert.deepEqual(quota.filter(r=>r.resource===resource),[{resource,state:'uncertain',settled_units:expectedUnits}])
   const event=(await app.query('SELECT tier,wake_status,wake_generation_state,wake_error,wake_tool_receipts FROM coordinator_events WHERE id=$1',[id])).rows[0]
   assert.equal(Object.keys(event.wake_tool_receipts??{}).filter(k=>k.startsWith(decision?'decision:':'web:')).length,0,'withdrawn local result must not publish a receipt')
   const calls=observed.get(id);assert.equal(decision?calls.decisionRequests:calls.webRequests,1)
   if(!decision)assert.equal(calls.requests,1,'no next generation after source withdrawal')
   assert.equal((await app.query("SELECT 1 FROM coordinator_messages WHERE source_event_id=$1 AND message->>'role'='assistant'",[id])).rowCount,0)
   log({phase:'actual production '+resource+' HTTP200 → issue soft-delete → local commit403: no publication/refund/resend',eventId:id,workflowStatus:run?await run.status:null,calls,quota,event})
  }
 }
 log({result:baseline?'REPRODUCED actual compiled shared-context policy bypass with synthetic markers only':'PASS actual authenticated dual-workspace SDK prompt-policy boundary; all model transport loopback',buildId:readFileSync('.next/BUILD_ID','utf8').trim()})
}finally{for(const r of runs)try{if(['pending','running'].includes(await r.status))await r.cancel()}catch{}server.closeAllConnections();await new Promise(r=>server.close(()=>r()));await Promise.all([app.end(),workspace.end()])}
