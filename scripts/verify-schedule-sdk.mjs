// Actual authenticated Bot → compiled WorkflowAgent schedule tools → persisted
// due claim → formal scheduled read model → original chat. All HTTP is loopback.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {createHmac,randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {Pool} from 'pg'
import {getWorld} from 'workflow/runtime'
import {resourceFixture,isolatedResourceUrls} from '../lib/resources/test-fixtures.ts'
import {COORDINATOR_MODEL} from '../lib/coordinator/model.ts'
import {AGENT_ROUTE,coordinatorRoute} from '../lib/policy/model.ts'
const urls=isolatedResourceUrls(),origin='http://127.0.0.1:3180',sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
if(process.env.CI!=='true'||process.env.WORKFLOW_TARGET_WORLD!=='local'||process.env.WORKFLOW_LOCAL_BASE_URL!==origin+'/mikka'||!process.env.CRON_SECRET||!['/workspace/176-private-evidence/','/tmp/mikka-resource-176-'].some(p=>process.env.WORKFLOW_LOCAL_DATA_DIR?.startsWith(p))||['VERCEL','TELEGRAM_BOT_TOKEN','FIRECRAWL_API_KEY','AI_GATEWAY_API_KEY','OPENCODE_API_KEY','COMPOSIO_API_KEY'].some(k=>process.env[k]))throw Error('isolated keyless schedule SDK acceptance only')
assert.equal(readFileSync('.next/resource-source-sha','utf8').trim(),sha)
const app=new Pool({connectionString:urls.app}),workspace=new Pool({connectionString:urls.workspace}),world=await getWorld()
const f=await resourceFixture(app,workspace,[coordinatorRoute(COORDINATOR_MODEL),AGENT_ROUTE],false)
const counts=new Map(),toolCalls=[],readText='CONTROLLED scheduled read result for the original private Bot conversation'
let sourceEventId,scheduleId,readScheduleId
const log=x=>console.log(JSON.stringify({at:new Date().toISOString(),source:sha,...x}))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function wait(fn,label){const end=Date.now()+60000;while(Date.now()<end){if(await fn())return;await sleep(100)}throw Error('timeout '+label)}
const answer=text=>({content:[{type:'text',text}],finishReason:{unified:'stop',raw:'stop'},usage:{inputTokens:{total:2,noCache:2,cacheRead:0,cacheWrite:0},outputTokens:{total:2,text:2,reasoning:0}},warnings:[]})
const definition=(title,task,delay=60000)=>({title,timezone:'America/New_York',timing:{kind:'once',at:new Date(Date.now()+delay).toISOString()},task,misfire:'catch_up_once',maxLatenessMinutes:5})
const server=createServer(async(req,res)=>{
 try{
  let text='';for await(const b of req)text+=b
  assert.equal(req.url,'/model')
  const op=req.headers['x-controlled-operation-id'];assert.equal(typeof op,'string')
  const n=(counts.get(op)??0)+1;counts.set(op,n)
  if(!sourceEventId){
   const captured=(await app.query('SELECT "userId",kind FROM coordinator_events WHERE id=$1',[op])).rows[0]
   if(captured?.userId===f.owner&&captured.kind==='user_message')sourceEventId=op
  }
  if(op===sourceEventId){
   const old=(await app.query('SELECT id,status,version FROM user_schedules WHERE owner_id=$1 ORDER BY created_at',[f.owner])).rows[0]
   if(old)scheduleId=old.id
   const calls=[
    ['schedule_create',{definition:definition('CONTROLLED mutation target',{kind:'reminder',text:'This cancelled reminder must never execute'})}],
    ['schedule_pause',{scheduleId,version:1}],
    ['schedule_update',{scheduleId,version:2,definition:definition('CONTROLLED replacement',{kind:'reminder',text:'Still must not execute'},120000)}],
    ['schedule_resume',{scheduleId,version:3}],
    ['schedule_list',{}],
    ['schedule_history',{scheduleId}],
    ['schedule_cancel',{scheduleId,version:4}],
    ['schedule_create',{definition:definition('CONTROLLED scheduled read',{kind:'agent_read',prompt:'Return only the explicitly controlled read result; no connected action is authorized.',allowedActions:[]},3000)}],
   ]
   if(n<=calls.length){
    const [name,input]=calls[n-1];toolCalls.push(name)
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({...answer(''),content:[{type:'tool-call',toolCallId:'controlled-schedule-'+n,toolName:name,input:JSON.stringify(input)}],finishReason:{unified:'tool-calls',raw:'tool_calls'}}));return
   }
   assert.equal(n,9)
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(answer('Persisted the requested scoped read schedule and cancelled the separate mutation test.')));return
  }
  const row=(await app.query('SELECT s.owner_id,s.id FROM schedule_occurrences o JOIN user_schedules s ON s.id=o.schedule_id WHERE o.operation_id=$1',[op])).rows[0]
  assert.equal(row?.owner_id,f.owner);assert.equal(row.id,readScheduleId);assert.equal(n,1)
  const payload=JSON.parse(text);assert.deepEqual(payload.tools??[],[],'scheduled task exposes no connected/write tools')
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(answer(readText)))
 }catch(error){console.error('controlled schedule transport rejected:',error.message);res.writeHead(500).end('{}')}
})
server.listen(6183,'127.0.0.1');await once(server,'listening')
try{
 await wait(async()=>{try{return(await fetch(origin+'/mikka/api/auth/get-session')).status===200}catch{return false}},'Next ready')
 const token=randomUUID(),cookie=`better-auth.session_token=${encodeURIComponent(token+'.'+createHmac('sha256','isolated-resource-proof-no-production-authorization-123456789').update(token).digest('base64'))}`
 await app.query('INSERT INTO session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',[randomUUID(),token,f.owner])
 const submissionId=randomUUID(),response=await fetch(origin+'/mikka/api/coordinator/messages',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({submissionId,text:'Create a one-time read-only task for my private Bot conversation, confirm its timezone and next execution; exercise only the explicitly requested metadata lifecycle on a separate reminder.'})})
 assert.equal(response.status,202);sourceEventId=(await response.json()).sourceEventId
 // Provider execution is asynchronous; resolve the canonical server-issued source
 // before the first request rather than trusting any client-generated operation ID.
 await wait(async()=>['completed','failed'].includes((await app.query('SELECT wake_status FROM coordinator_events WHERE id=$1',[sourceEventId])).rows[0]?.wake_status),'actual Bot schedule tool loop')
 const event=(await app.query('SELECT wake_status,wake_error,wake_workspace_id,wake_transport_run_id FROM coordinator_events WHERE id=$1',[sourceEventId])).rows[0]
 assert.equal(event.wake_status,'completed',JSON.stringify(event));assert.equal(event.wake_workspace_id,f.workspaceId)
 assert.deepEqual(toolCalls,['schedule_create','schedule_pause','schedule_update','schedule_resume','schedule_list','schedule_history','schedule_cancel','schedule_create'])
 const rows=(await app.query('SELECT * FROM user_schedules WHERE owner_id=$1 ORDER BY created_at',[f.owner])).rows
 assert.equal(rows.length,2);const cancelled=rows[0],read=rows[1];readScheduleId=read.id
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.version,5)
 assert.equal(read.status,'active');assert.equal(read.definition.timezone,'America/New_York')
 assert.equal(read.conversation,'coordinator');assert.equal(read.session_id,f.owner);assert.equal(read.source_id,sourceEventId);assert.equal(read.workspace_id,f.workspaceId)
 const steps=(await world.steps.list({runId:event.wake_transport_run_id,resolveData:'none'})).data.map(s=>({name:s.stepName,status:s.status}))
 assert.equal(steps.filter(s=>s.name.includes('executeWakeTool')&&s.status==='completed').length,8)
 const messages=(await app.query('SELECT message FROM coordinator_messages WHERE source_event_id=$1',[sourceEventId])).rows
 const outputs=messages.flatMap(r=>Array.isArray(r.message.content)?r.message.content:[]).filter(p=>p.type==='tool-result')
 assert.equal(outputs.length,8);assert.ok(outputs.every(p=>p.output?.value&&!p.output.value.error),JSON.stringify(outputs))
 log({phase:'authenticated HTTP → actual Bot durable tool lifecycle; no direct schedule handler call',sourceEventId,scheduleId,readScheduleId,toolCalls,modelRequests:counts.get(sourceEventId),workspaceId:f.workspaceId,nextUtc:read.next_at,timezone:read.definition.timezone,steps})
 const unauthorized=await fetch(origin+'/mikka/api/cron/runtime');assert.equal(unauthorized.status,401)
 // A real Next process restart after schedule commit and before its due scan.
 execFileSync('docker',['kill','--signal','KILL','mikka176-resource-next'],{stdio:'ignore'})
 execFileSync('docker',['start','mikka176-resource-next'],{stdio:'ignore'})
 await wait(async()=>{try{return(await fetch(origin+'/mikka/api/auth/get-session')).status===200}catch{return false}},'Next restarted')
 await wait(()=>Date.now()>=new Date(read.next_at).getTime(),'persisted due UTC')
 const sweep=()=>fetch(origin+'/mikka/api/cron/runtime',{headers:{authorization:'Bearer '+process.env.CRON_SECRET}})
 const sweeps=await Promise.all(Array.from({length:10},sweep));const bodies=await Promise.all(sweeps.map(r=>r.json()))
 assert.ok(sweeps.every(r=>r.status===200),JSON.stringify(bodies))
 const occurrences=(await app.query('SELECT * FROM schedule_occurrences WHERE schedule_id=$1',[readScheduleId])).rows
 assert.equal(occurrences.length,1);const occurrence=occurrences[0]
 assert.equal(occurrence.status,'succeeded');assert.ok(occurrence.reported_at);assert.equal(occurrence.generation_state,'returned')
 assert.equal(counts.get(occurrence.operation_id),1);assert.equal(counts.get(sourceEventId),9)
 assert.equal((await app.query('SELECT count(*)::int n FROM schedule_occurrences WHERE schedule_id=$1',[scheduleId])).rows[0].n,0)
 const report=(await app.query('SELECT "userId",message FROM coordinator_messages WHERE id=$1',[occurrence.operation_id])).rows
 assert.equal(report.length,1);assert.equal(report[0].userId,f.owner);assert.ok(report[0].message.content.includes(readText))
 const resultEvent=(await app.query('SELECT "userId",tier,payload FROM coordinator_events WHERE id=$1',[occurrence.id])).rows[0]
 assert.equal(resultEvent.userId,f.owner);assert.equal(resultEvent.tier,'background');assert.equal(resultEvent.payload.operationId,occurrence.operation_id)
 const quota=(await app.query('SELECT resource,state,settled_units FROM quota_reservations WHERE owner_id=$1 ORDER BY created_at',[f.owner])).rows
 assert.equal(quota.filter(r=>r.resource==='coordinator.model'&&r.state==='settled').length,9)
 assert.deepEqual(quota.filter(r=>r.resource==='schedule.model').map(r=>[r.state,r.settled_units]),[['settled','2']])
 const replay=await sweep();assert.equal(replay.status,200)
 assert.equal(counts.get(occurrence.operation_id),1);assert.equal(counts.get(sourceEventId),9)
 assert.equal((await app.query('SELECT count(*)::int n FROM coordinator_messages WHERE id=$1',[occurrence.operation_id])).rows[0].n,1)
 log({phase:'actual Next restart → ten manual authenticated due sweeps → formal scheduled model once → original chat once; replay sends zero',occurrenceId:occurrence.id,operationId:occurrence.operation_id,readScheduleId,sweeps:bodies,modelRequests:Object.fromEntries(counts),quota,resultEvent})
 log({result:'PASS actual Bot/Next/PG/Workflow schedule lifecycle and restarted due execution; all providers controlled, no production cron or external action',source:sha,buildId:readFileSync('.next/BUILD_ID','utf8').trim()})
}finally{server.closeAllConnections();await new Promise(r=>server.close(()=>r()));await Promise.all([app.end(),workspace.end()])}
