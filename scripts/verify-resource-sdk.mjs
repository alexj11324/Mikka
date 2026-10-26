// Real installed SDK and compiled formal workflow. Provider is keyless loopback.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {Pool} from 'pg'
import {start} from 'workflow/api'
import {getWorld} from 'workflow/runtime'
import {CoordinatorInbox,isolatedInboxOptions} from '../lib/coordinator/wake-test-helpers.ts'
import {resourceFixture} from '../lib/resources/test-fixtures.ts'
import {coordinatorRoute} from '../lib/policy/model.ts'
import {COORDINATOR_MODEL} from '../lib/coordinator/model.ts'
const appUrl=process.env.RESOURCE_APP_TEST_URL,workspaceUrl=process.env.RESOURCE_WORKSPACE_TEST_URL
if(!appUrl||!workspaceUrl||[appUrl,workspaceUrl].some(x=>new URL(x).hostname!=='127.0.0.1'||!new URL(x).pathname.endsWith('_176'))||process.env.WORKFLOW_TARGET_WORLD!=='local'||process.env.WORKFLOW_LOCAL_BASE_URL!=='http://127.0.0.1:3180/mikka'||!process.env.WORKFLOW_LOCAL_DATA_DIR?.startsWith('/workspace/176-private-evidence/')||['VERCEL','AI_GATEWAY_API_KEY','DECISION_GATEWAY_API_KEY','OPENCODE_API_KEY','COMPOSIO_API_KEY','OPENAI_API_KEY','FIRECRAWL_API_KEY'].some(k=>process.env[k]))throw new Error('isolated keyless resource SDK only')
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
const diagnostic=process.env.RESOURCE_DIAGNOSTIC_BUILD==='1'
if(!diagnostic)assert.equal(readFileSync('.next/resource-source-sha','utf8').trim(),sha)
const app=new Pool({connectionString:appUrl,max:5}),workspace=new Pool({connectionString:workspaceUrl,max:5}),world=await getWorld()
const inbox=new CoordinatorInbox(app,isolatedInboxOptions(app,workspace,()=>new Date()))
const manifest=JSON.parse(readFileSync('.next/diagnostics/workflows-manifest.json'))
const entry=manifest.workflows['workflows/coordinator/workflow.ts'].coordinatorTurn
let currentOperation,calls=0
const server=createServer(async(req,res)=>{
 for await(const _d of req){}
 calls++
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({content:[{type:'text',text:'CONTROLLED compiled WorkflowAgent response; no real provider'}],finishReason:{unified:'stop',raw:'stop'},usage:{inputTokens:{total:5,noCache:5,cacheRead:0,cacheWrite:0},outputTokens:{total:7,text:7,reasoning:0}},warnings:[]}))
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
 log({result:'PASS actual compiled WorkflowAgent generation, canonical quota/source fence and original chat publication; controlled provider HTTP',source:sha,diagnosticBuild:diagnostic})
}finally{
 for(const r of runs)try{if(['pending','running'].includes(await r.status))await r.cancel()}catch{}
 server.closeAllConnections();await new Promise(r=>server.close(()=>r()));await Promise.all([app.end(),workspace.end()])
}
