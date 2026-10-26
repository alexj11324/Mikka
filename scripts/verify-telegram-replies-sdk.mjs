// Actual compiled Coordinator / Workflow SDK. All model and Telegram HTTP is controlled loopback.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {start} from 'workflow/api'
import {getWorld} from 'workflow/runtime'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {resourceFixture,isolatedResourceUrls} from '../lib/resources/test-fixtures.ts'
import {coordinatorRoute} from '../lib/policy/model.ts'
import {COORDINATOR_MODEL} from '../lib/coordinator/model.ts'
import {CoordinatorInbox,isolatedInboxOptions} from '../lib/coordinator/wake-test-helpers.ts'
const urls=isolatedResourceUrls(),source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
if(process.env.CI!=='true'||process.env.WORKFLOW_LOCAL_BASE_URL!=='http://127.0.0.1:3180/mikka'||!['/workspace/176-private-evidence/','/tmp/mikka-telegram-294-'].some(p=>process.env.WORKFLOW_LOCAL_DATA_DIR?.startsWith(p))||['TELEGRAM_BOT_TOKEN','FIRECRAWL_API_KEY','AI_GATEWAY_API_KEY','COMPOSIO_API_KEY','VERCEL'].some(k=>process.env[k]))throw new Error('isolated keyless Telegram acceptance only')
assert.equal(readFileSync('.next/telegram-source-sha','utf8').trim(),source)
const app=new Pool({connectionString:urls.app}),workspace=new Pool({connectionString:urls.workspace}),inbox=new CoordinatorInbox(app,isolatedInboxOptions(app,workspace,()=>new Date())),world=await getWorld(),plans=new Map(),calls=new Map(),roundFacts=new Map(),destinations=new Map(),runs=[]
const entry=JSON.parse(readFileSync('.next/diagnostics/workflows-manifest.json')).workflows['workflows/coordinator/workflow.ts'].coordinatorTurn
const log=x=>console.log(JSON.stringify({at:new Date().toISOString(),source,...x}))
const server=createServer(async(req,res)=>{
 let text='';for await(const d of req)text+=d
 if(req.url==='/telegram'){
  const body=JSON.parse(text),plan=destinations.get(body.threadId)
  assert.ok(plan,'only an explicitly registered synthetic destination')
  plan.attempts.push(body.text)
  const attempt=plan.attempts.filter(x=>x===body.text).length
  if(plan.revoke&&plan.attempts.length===1){
   res.writeHead(503).end('{}')
   // The current send transaction holds the link lock. Revoke after its
   // rejected request returns, before SDK retries the same cached step input.
   plan.revoked=app.query('DELETE FROM telegram_links WHERE "userId"=$1',[plan.owner])
   return
  }
  if(plan.failSecondOnce&&plan.attempts.length===2&&attempt===1){res.writeHead(503).end('{}');return}
  plan.delivered.push(body.text);res.writeHead(200).end('{}');return
 }
 assert.equal(req.url,'/model')
 const id=req.headers['x-controlled-operation-id'];calls.set(id,(calls.get(id)??0)+1)
 const mode=plans.get(id)
 if(mode==='rounds'||mode==='budget'){
  const payload=JSON.parse(text),instructions=JSON.stringify(payload.prompt)
  const facts=roundFacts.get(id)??[];facts.push({round:calls.get(id),noticeCount:(instructions.match(/这条消息已经用了/g)??[]).length,hasOriginalInstructions:instructions.includes('Use schedule_create'),toolChoice:payload.toolChoice});roundFacts.set(id,facts)
  if(calls.get(id)<120){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({content:[{type:'tool-call',toolCallId:'controlled-list-'+calls.get(id),toolName:'list_issues',input:'{}'}],finishReason:{unified:'tool-calls',raw:'tool_calls'},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}},warnings:[]}));return}
 }
 if(mode==='fail'){res.writeHead(503,{'content-type':'application/json'}).end('{}');return}
 const answer=mode==='empty'?'':mode==='long'?'A'.repeat(4095)+'😀'+'B'.repeat(6000):'CONTROLLED recovered Telegram response'
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({content:[{type:'text',text:answer}],finishReason:{unified:'stop',raw:'stop'},usage:{inputTokens:{total:3,noCache:3,cacheRead:0,cacheWrite:0},outputTokens:{total:3,text:3,reasoning:0}},warnings:[]}))
});server.listen(6183,'127.0.0.1');await once(server,'listening')
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function wait(fn,label){const end=Date.now()+90000;while(Date.now()<end){if(await fn())return;await sleep(100)}throw new Error('timeout '+label)}
async function fixture(extra={}){
 const f=await resourceFixture(app,workspace,[coordinatorRoute(COORDINATOR_MODEL)],!extra.unmanaged),threadId='telegram:controlled:'+randomUUID(),telegramUserId='synthetic-'+randomUUID()
 await app.query('INSERT INTO telegram_links("userId","telegramUserId") VALUES($1,$2)',[f.owner,telegramUserId])
 destinations.set(threadId,{owner:f.owner,attempts:[],delivered:[],...extra})
 return {...f,threadId,telegramUserId}
}
const pending=async owner=>(await app.query('SELECT telegram_reply_pending FROM coordinator_sessions WHERE "userId"=$1',[owner])).rows[0].telegram_reply_pending
async function launch(f,mode,telegram=true){
 const id=randomUUID();plans.set(id,mode)
 await app.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,wake_workspace_id,wake_next_at) VALUES($1::uuid,$2,'user_message',$1::text,$3,'attention',$4,clock_timestamp()-interval '1 second')`,[id,f.owner,{text:'CONTROLLED issue 294 acceptance',workspaceId:f.workspaceId,...(telegram?{telegram:{threadId:f.threadId,telegramUserId:f.telegramUserId,messageId:1}}:{})},f.workspaceId])
 const claim=await inbox.claim(f.owner);assert.ok(claim&&'delivery'in claim)
 const run=await start({workflowId:entry.workflowId},[f.owner,claim.delivery]);runs.push(run)
 await wait(async()=>['completed','failed','cancelled'].includes(await run.status),'formal Coordinator terminal')
 assert.equal(await run.status,'completed')
 const event=(await app.query('SELECT wake_status,wake_generation_state,wake_error,processed_at FROM coordinator_events WHERE id=$1',[id])).rows[0]
 const steps=(await world.steps.list({runId:run.runId,resolveData:'none'})).data.map(s=>({name:s.stepName,status:s.status}))
 return {id,runId:run.runId,event,steps,workflowOutcome:await run.returnValue}
}
try{
 await wait(async()=>{try{return(await fetch('http://127.0.0.1:3180/mikka/api/auth/get-session')).status===200}catch{return false}},'Next ready')
 log({phase:'actual compiled Telegram recovery ready',buildId:readFileSync('.next/BUILD_ID','utf8').trim(),realModel:false,realTelegram:false,cloudWorkflow:false})
 const empty=await fixture(),r=await launch(empty,'empty'),sent=destinations.get(empty.threadId)
 assert.equal(r.event.wake_status,'completed');assert.deepEqual(sent.delivered,['没有生成回复，请再试一次']);assert.deepEqual(await pending(empty.owner),[]);assert.equal(calls.get(r.id),1)
 assert.ok((await app.query("SELECT 1 FROM coordinator_messages WHERE source_event_id=$1 AND message->>'content'=$2",[r.id,'没有生成回复，请再试一次'])).rowCount)
 log({phase:'empty final answer checkpointed and delivered once as fallback',eventId:r.id,runId:r.runId,modelRequests:calls.get(r.id),telegramRequests:sent.attempts.length,steps:r.steps})
 const restart=await fixture(),failed=await launch(restart,'fail');assert.equal(failed.event.wake_status,'failed');assert.equal((await pending(restart.owner)).length,1)
 execFileSync('docker',['kill','--signal','KILL','mikka294-next'],{stdio:'ignore'});execFileSync('docker',['start','mikka294-next'],{stdio:'ignore'})
 await wait(async()=>{try{return(await fetch('http://127.0.0.1:3180/mikka/api/auth/get-session')).status===200}catch{return false}},'actual Next process restarted')
 const recovered=await launch(restart,'normal',false),destination=destinations.get(restart.threadId)
 assert.equal(recovered.event.wake_status,'completed');assert.equal(destination.delivered.length,1);assert.deepEqual(await pending(restart.owner),[])
 assert.equal(calls.get(failed.id),1);assert.equal(calls.get(recovered.id),1)
 log({phase:'failed Telegram turn retained destination across actual Next SIGKILL and a distinct successful web turn',failedEventId:failed.id,nextEventId:recovered.id,failedRunId:failed.runId,nextRunId:recovered.runId,modelRequests:[calls.get(failed.id),calls.get(recovered.id)],telegramRequests:destination.attempts.length})
 const long=await fixture({failSecondOnce:true}),chunks=await launch(long,'long'),chunkPlan=destinations.get(long.threadId)
 assert.equal(chunks.event.wake_status,'completed');assert.equal(chunkPlan.delivered.join(''),'A'.repeat(4095)+'😀'+'B'.repeat(6000));assert.equal(chunkPlan.attempts.filter(x=>x===chunkPlan.delivered[0]).length,1)
 assert.equal(chunkPlan.attempts.length,chunkPlan.delivered.length+1);assert.deepEqual(await pending(long.owner),[]);assert.equal(calls.get(chunks.id),1)
 log({phase:'real durable chunk retry resends only rejected chunk; prior chunk and model remain once',eventId:chunks.id,runId:chunks.runId,chunkAttempts:chunkPlan.attempts.length,deliveredChunks:chunkPlan.delivered.length,modelRequests:calls.get(chunks.id),steps:chunks.steps})
 const revoked=await fixture({revoke:true}),denied=await launch(revoked,'normal'),revokePlan=destinations.get(revoked.threadId);await revokePlan.revoked
 assert.equal(denied.event.wake_status,'completed');assert.equal(revokePlan.attempts.length,1);assert.equal(revokePlan.delivered.length,0);assert.equal((await pending(revoked.owner)).length,1)
 assert.ok(denied.steps.some(s=>s.name.includes('telegramReplyThreads')&&s.status==='completed'));assert.ok(denied.steps.some(s=>s.name.includes('sendTelegramChunk')&&s.status==='failed'))
 log({phase:'actual SDK retries with cached target-selection result fail fresh link fence; no new HTTP or false delivery cleanup',eventId:denied.id,runId:denied.runId,telegramRequests:revokePlan.attempts.length,pendingTargets:1,steps:denied.steps})
 const roundScope=await fixture({unmanaged:true}),roundRun=await launch(roundScope,'rounds',false),facts=roundFacts.get(roundRun.id),modelRequests=calls.get(roundRun.id)
 assert.ok(modelRequests>0&&modelRequests<=120)
 assert.ok(facts.every(f=>f.hasOriginalInstructions))
 const roundQuota=(await app.query('SELECT count(*)::int n,sum(settled_units)::text units FROM quota_reservations WHERE owner_id=$1 AND resource=\'coordinator.model\' AND state IN (\'settled\',\'uncertain\')',[roundScope.owner])).rows[0]
 assert.deepEqual(roundQuota,{n:modelRequests,units:String(modelRequests*2)})
 if(roundRun.event.wake_status==='completed'){
  assert.equal(modelRequests,120)
  assert.equal(facts[89].noticeCount,0);assert.equal(facts[90].noticeCount,1);assert.equal(facts[119].noticeCount,1)
  assert.deepEqual(facts[119].toolChoice,{type:'none'})
  log({phase:'actual Bot reached 120-round ceiling; final round tools off and one notice',eventId:roundRun.id,runId:roundRun.runId,modelRequests,quota:roundQuota,lastRound:facts[119]})
 }else{
  // A ceiling is not a promise to outrun the unchanged total deadline. The
  // separate strict round-helper tests assert indices 90 and 119 exactly.
  assert.equal(roundRun.event.wake_status,'failed');assert.ok(modelRequests<120)
  assert.equal(roundRun.workflowOutcome?.generationDeadlineReached,true)
  assert.ok(roundRun.workflowOutcome.generationElapsedMs>=45000)
  assert.equal(roundRun.event.wake_error,'wakeGenerationUncertain')
  log({phase:'actual SDK hit the existing 45s generation deadline before 120-round ceiling; no claim of 120-round completion',eventId:roundRun.id,runId:roundRun.runId,modelRequests,quota:roundQuota,workflowOutcome:roundRun.workflowOutcome,ceiling:120})
 }
 const budget=await fixture({unmanaged:true})
 await app.query('UPDATE quota_tenants SET budget_units=5 WHERE workspace_id=$1',[budget.workspaceId])
 const stopped=await launch(budget,'budget',false)
 assert.equal(stopped.event.wake_status,'failed');assert.equal(calls.get(stopped.id),2)
 const held=(await app.query('SELECT count(*)::int n,sum(settled_units)::text units FROM quota_reservations WHERE owner_id=$1',[budget.owner])).rows[0]
 assert.deepEqual(held,{n:2,units:'4'})
 log({phase:'existing quota stops actual Bot before a third send despite 120-round cap; prior successful rounds remain charged',eventId:stopped.id,runId:stopped.runId,modelRequests:2,quota:held,event:stopped.event})
 log({result:'PASS actual Next/PG/Workflow SDK Telegram pending recovery, empty fallback, chunk retry and cached-step authority fence; all external transport controlled'})
}finally{for(const r of runs)try{if(['pending','running'].includes(await r.status))await r.cancel()}catch{}server.closeAllConnections();await new Promise(r=>server.close(()=>r()));await Promise.all([app.end(),workspace.end()])}
