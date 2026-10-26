// Real installed SDK and compiled formal workflow. Provider is keyless loopback.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {createHmac,randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {Pool} from 'pg'
import {start} from 'workflow/api'
import {getWorld} from 'workflow/runtime'
import {CoordinatorInbox,isolatedInboxOptions} from '../lib/coordinator/wake-test-helpers.ts'
import {resourceFixture} from '../lib/resources/test-fixtures.ts'
import {coordinatorRoute} from '../lib/policy/model.ts'
import {COORDINATOR_MODEL} from '../lib/coordinator/model.ts'
const appUrl=process.env.RESOURCE_APP_TEST_URL,workspaceUrl=process.env.RESOURCE_WORKSPACE_TEST_URL
if(!appUrl||!workspaceUrl||[appUrl,workspaceUrl].some(x=>new URL(x).hostname!=='127.0.0.1'||!new URL(x).pathname.endsWith('_176'))||process.env.WORKFLOW_TARGET_WORLD!=='local'||process.env.WORKFLOW_LOCAL_BASE_URL!=='http://127.0.0.1:3180/mikka'||!['/workspace/176-private-evidence/','/tmp/mikka-resource-176-'].some(prefix=>process.env.WORKFLOW_LOCAL_DATA_DIR?.startsWith(prefix))||['VERCEL','AI_GATEWAY_API_KEY','DECISION_GATEWAY_API_KEY','OPENCODE_API_KEY','COMPOSIO_API_KEY','OPENAI_API_KEY','FIRECRAWL_API_KEY'].some(k=>process.env[k]))throw new Error('isolated keyless resource SDK only')
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
const diagnostic=process.env.RESOURCE_DIAGNOSTIC_BUILD==='1'
if(!diagnostic)assert.equal(readFileSync('.next/resource-source-sha','utf8').trim(),sha)
const app=new Pool({connectionString:appUrl,max:5}),workspace=new Pool({connectionString:workspaceUrl,max:5}),world=await getWorld()
const inbox=new CoordinatorInbox(app,isolatedInboxOptions(app,workspace,()=>new Date()))
const manifest=JSON.parse(readFileSync('.next/diagnostics/workflows-manifest.json'))
const entry=manifest.workflows['workflows/coordinator/workflow.ts'].coordinatorTurn
let currentOperation,calls=0
const plans=new Map(),counts=new Map()
const answer=(text)=>({content:[{type:'text',text}],finishReason:{unified:'stop',raw:'stop'},usage:{inputTokens:{total:5,noCache:5,cacheRead:0,cacheWrite:0},outputTokens:{total:7,text:7,reasoning:0}},warnings:[]})
const server=createServer(async(req,res)=>{
 let body='';for await(const d of req)body+=d
 const id=req.headers['x-controlled-operation-id'],logical=req.headers['x-controlled-logical-endpoint']
 let plan=plans.get(id)
 if(!plan&&id){const event=(await app.query('SELECT payload FROM coordinator_events WHERE id=$1',[id])).rows[0];const text=event?.payload?.text;if(text?.startsWith('CONTROLLED_TOOL ')){plan=JSON.parse(text.slice(16));plans.set(id,plan)}}
 const c=counts.get(id)??{model:0,search:0,scrape:0};counts.set(id,c)
 if(logical?.startsWith('https://api.firecrawl.dev/v2/')){
  const op=logical.endsWith('/scrape')?'scrape':'search';c[op]++
  if(plan?.reject){res.writeHead(plan.reject,{'content-type':'application/json','retry-after':'1'}).end('{}');return}
  const input=JSON.parse(body)
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(op==='scrape'?{success:true,data:{markdown:'Controlled public page evidence. '+('x'.repeat(14000)),metadata:{statusCode:200,sourceURL:input.url,url:input.url}}}:{success:true,data:{web:[{url:'https://fixture.public.example.org/page',title:'controlled title',description:'controlled snippet'}]}}));return
 }
 c.model++;calls++
 if(plan?.operation&&(c.model===1||(plan.repeat&&c.model===2))){
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({...answer(''),content:[{type:'tool-call',toolCallId:'controlled-tool-one',toolName:plan.operation==='scrape'?'read_webpage':'web_search',input:JSON.stringify(plan.operation==='scrape'?{url:plan.url??'https://fixture.public.example.org/page'}:{query:'controlled public evidence',limit:2})}],finishReason:{unified:'tool-calls',raw:'tool_calls'}}));return
 }
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(answer('CONTROLLED compiled WorkflowAgent response; no real provider')))
})
server.listen(6183,'127.0.0.1');await once(server,'listening')
const log=x=>console.log(JSON.stringify({at:new Date().toISOString(),...x}))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function wait(fn,label){const until=Date.now()+45000;while(Date.now()<until){if(await fn())return;await sleep(100)}throw new Error('timeout '+label)}
const runs=[]
try{
 await wait(async()=>{try{return(await fetch('http://127.0.0.1:3180/mikka/api/auth/get-session')).status===200}catch{return false}},'compiled Next ready')
 log({phase:'real SDK model path ready',source:sha,diagnosticBuild:diagnostic,buildId:readFileSync('.next/BUILD_ID','utf8').trim(),realProvider:false,cloudWorkflow:false})
 const f=await resourceFixture(app,workspace,[coordinatorRoute(COORDINATOR_MODEL)])
 currentOperation=f.operationId
 await app.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,wake_workspace_id,wake_next_at) VALUES($1::uuid,$2,'user_message',$1::text,$3,'attention',$4,clock_timestamp()-interval '1 second')`,[f.operationId,f.owner,{text:'Return a controlled backend test response without tools',workspaceId:f.workspaceId},f.workspaceId])
 const claim=await inbox.claim(f.owner);assert.ok(claim&&'delivery'in claim)
 for(let n=0;n<10;n++)runs.push(await start({workflowId:entry.workflowId},[f.owner,claim.delivery]))
 await wait(async()=>{
  const statuses=await Promise.all(runs.map(r=>r.status))
  return statuses.every(x=>['completed','failed','cancelled'].includes(x))
 },'ten formal compiled workflows terminal')
 const stepLists=await Promise.all(runs.map(async r=>({runId:r.runId,status:await r.status,steps:(await world.steps.list({runId:r.runId,resolveData:'none'})).data.map(s=>({name:s.stepName,status:s.status}))})))
 log({phase:'actual compiled model steps',operationId:currentOperation,calls,stepLists})
 const event=(await app.query('SELECT wake_status,wake_generation_state,wake_error,processed_at FROM coordinator_events WHERE id=$1',[f.operationId])).rows[0]
 const quota=(await app.query('SELECT resource,state,settled_units,usage FROM quota_reservations WHERE owner_id=$1',[f.owner])).rows
 log({phase:'persistent model and publication state',event,quota})
 assert.equal(event.wake_status,'completed');assert.ok(event.processed_at);assert.equal(calls,1)
 assert.deepEqual(quota.map(r=>[r.resource,r.state,r.settled_units]),[['coordinator.model','settled','2']])
 assert.equal((await app.query("SELECT count(*)::int n FROM coordinator_messages WHERE source_event_id=$1 AND message->>'role'='assistant'",[f.operationId])).rows[0].n,1)
 assert.ok(stepLists.some(r=>r.steps.some(s=>s.name.includes('doGenerateStep')&&s.status==='completed')))
 const origin='http://127.0.0.1:3180'
 async function cookie(owner){
  const token=randomUUID()
  await app.query('INSERT INTO session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',[randomUUID(),token,owner])
  return `better-auth.session_token=${encodeURIComponent(token+'.'+createHmac('sha256','isolated-resource-proof-no-production-authorization-123456789').update(token).digest('base64'))}`
 }
 for(const plan of [{operation:'scrape'},{operation:'search'},{operation:'scrape',repeat:true},{operation:'scrape',managed:true},{operation:'scrape',reject:429},{operation:'scrape',url:'https://127.0.0.1/private'}]){
  // Community scope has no managed tool executor. Managed policy is verified
  // separately below and must keep its existing denial.
  const actor=await resourceFixture(app,workspace,[coordinatorRoute(COORDINATOR_MODEL)],Boolean(plan.managed)),authCookie=await cookie(actor.owner),submissionId=randomUUID()
  // The event ID is server-derived, so register the plan before asynchronous wake.
  // Resolve the canonical id from recordUserSubmission rather than guessing it.
  const post=()=>fetch(origin+'/mikka/api/coordinator/messages',{method:'POST',headers:{cookie:authCookie,origin,'content-type':'application/json'},body:JSON.stringify({text:'CONTROLLED_TOOL '+JSON.stringify(plan),submissionId})})
  // The transport chooses the controlled fixture plan from the persisted text.
  plans.set(actor.owner,plan)
  const responses=await Promise.all(Array.from({length:10},post)),bodies=await Promise.all(responses.map(r=>r.json()))
  assert.ok(responses.every(r=>r.status===202),JSON.stringify(bodies))
  assert.equal(new Set(bodies.map(b=>b.sourceEventId)).size,1)
  const operationId=bodies[0].sourceEventId
  plans.set(operationId,plan)
  await wait(async()=>['completed','failed','cancelled'].includes((await app.query('SELECT wake_status FROM coordinator_events WHERE id=$1',[operationId])).rows[0]?.wake_status),'HTTP Bot tool completion')
  const row=(await app.query('SELECT wake_status,wake_error,wake_workspace_id,wake_transport_run_id FROM coordinator_events WHERE id=$1',[operationId])).rows[0]
  const quota=(await app.query('SELECT resource,state,settled_units FROM quota_reservations WHERE owner_id=$1 ORDER BY created_at',[actor.owner])).rows
  const stepData=row.wake_transport_run_id?(await world.steps.list({runId:row.wake_transport_run_id,resolveData:'none'})).data.map(s=>({name:s.stepName,status:s.status})):[]
  log({phase:'actual authenticated HTTP → durable Bot → WorkflowAgent tool loop',operationId,plan,row,counts:counts.get(operationId),quota,steps:stepData})
  assert.equal(row.wake_status,'completed');assert.equal(row.wake_workspace_id,actor.workspaceId)
  assert.equal(counts.get(operationId)?.model,plan.repeat?3:2)
  assert.equal(counts.get(operationId)?.scrape??0,plan.operation==='scrape'&&!plan.url&&!plan.managed?1:0)
  assert.equal(counts.get(operationId)?.search??0,plan.operation==='search'?1:0)
  assert.equal(quota.filter(r=>r.resource==='coordinator.model'&&r.state==='settled').length,plan.repeat?3:2)
  if(plan.reject)assert.ok(quota.some(r=>r.resource==='web.scrape'&&r.state==='refunded'&&r.settled_units==='0'))
  if(!plan.reject&&!plan.url&&!plan.managed)assert.ok(quota.some(r=>r.resource==='web.'+plan.operation&&r.state==='settled'&&r.settled_units==='1'))
  if(!plan.url)assert.ok(stepData.some(s=>s.name.includes('executeWakeTool')&&s.status==='completed'))
  else assert.equal(stepData.filter(s=>s.name.includes('executeWakeTool')).length,0)
  const chat=(await app.query("SELECT message FROM coordinator_messages WHERE source_event_id=$1 AND message->>'role'='assistant'",[operationId])).rows
  assert.ok(chat.length)
  const tools=(await app.query("SELECT message FROM coordinator_messages WHERE source_event_id=$1 AND message->>'role'='tool'",[operationId])).rows.flatMap(r=>r.message.content).filter(p=>p.type==='tool-result').map(p=>p.output.value)
  if(plan.operation==='scrape'&&!plan.url&&!plan.reject&&!plan.managed){
   assert.ok(tools.some(v=>v?.ok&&v.untrustedContent&&v.page?.markdown?.length===12000))
   assert.equal(quota.filter(r=>r.resource==='web.scrape').length,1)
  }
  if(plan.reject)assert.ok(tools.some(v=>v?.outcome==='rate_limited'&&v.notice==='search_degraded'))
  if(plan.managed){assert.equal(quota.filter(r=>r.resource.startsWith('web.')).length,0);assert.ok(tools.some(v=>v?.ok===false))}
 }
 // Real process loss after one paid generation and a durable result checkpoint.
 // The formal appendMessages SQL transaction is interrupted, not a mock store.
 const restart=await resourceFixture(app,workspace,[coordinatorRoute(COORDINATOR_MODEL)])
 await app.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,wake_workspace_id,wake_next_at) VALUES($1::uuid,$2,'user_message',$1::text,$3,'attention',$4,clock_timestamp()-interval '1 second')`,[restart.operationId,restart.owner,{text:'Controlled paid-result restart proof',workspaceId:restart.workspaceId},restart.workspaceId])
 const reservation=await inbox.claim(restart.owner);assert.ok(reservation&&'delivery'in reservation)
 const suffix=randomUUID().replaceAll('-',''),sequence='resource_seq_'+suffix,trigger='resource_fault_'+suffix
 await app.query(`CREATE SEQUENCE ${sequence}`)
 await app.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_event_id='${restart.operationId}'::uuid AND NEW.message->>'role'='assistant' THEN IF nextval('${sequence}')=1 THEN PERFORM pg_sleep(8); END IF; END IF; RETURN NEW; END $$`)
 await app.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON coordinator_messages FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
 const run=await start({workflowId:entry.workflowId},[restart.owner,reservation.delivery]);runs.push(run)
 await wait(async()=>(await app.query(`SELECT is_called FROM ${sequence}`)).rows[0].is_called,'paid actual append transaction reached')
 assert.equal(counts.get(restart.operationId)?.model,1)
 execFileSync('docker',['kill','--signal','KILL','mikka176-resource-next'],{stdio:'ignore'})
 log({phase:'actual paid Workflow generation, persisted outcome; Next worker SIGKILL inside publication transaction',operationId:restart.operationId,runId:run.runId})
 execFileSync('docker',['start','mikka176-resource-next'],{stdio:'ignore'})
 await wait(async()=>{try{return(await fetch(origin+'/mikka/api/auth/get-session')).status===200}catch{return false}},'Next restarted')
 await app.query(`ALTER TABLE coordinator_messages DISABLE TRIGGER ${trigger}`)
 await wait(async()=>(await app.query('SELECT wake_status FROM coordinator_events WHERE id=$1',[restart.operationId])).rows[0].wake_status==='completed','same actual SDK run publication after restart')
 assert.equal(counts.get(restart.operationId)?.model,1)
 const restartQuota=(await app.query('SELECT resource,state,settled_units FROM quota_reservations WHERE owner_id=$1',[restart.owner])).rows
 assert.deepEqual(restartQuota.map(r=>[r.resource,r.state,r.settled_units]),[['coordinator.model','settled','2']])
 assert.equal((await app.query("SELECT count(*)::int n FROM coordinator_messages WHERE source_event_id=$1 AND message->>'role'='assistant'",[restart.operationId])).rows[0].n,1)
 log({phase:'same actual compiled SDK workflow recovered after OS restart; checkpoint published once without another paid model call',operationId:restart.operationId,runId:run.runId,counts:counts.get(restart.operationId),quota:restartQuota})

 log({result:'PASS actual compiled WorkflowAgent generation, canonical quota/source fence, authenticated Bot search/scrape and original chat publication; controlled provider HTTP',source:sha,diagnosticBuild:diagnostic})
}finally{
 for(const r of runs)try{if(['pending','running'].includes(await r.status))await r.cancel()}catch{}
 server.closeAllConnections();await new Promise(r=>server.close(()=>r()));await Promise.all([app.end(),workspace.end()])
}
