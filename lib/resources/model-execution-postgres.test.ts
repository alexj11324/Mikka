import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {Pool} from 'pg'
import {ResourceModelExecution,type ModelExecutionScope,type ModelSourceFence} from './model-execution'
import {AGENT_ROUTE,authorizeModelRequest} from '../policy/model'
import {resourceFixture,isolatedResourceUrls,fixtureSigner} from './test-fixtures'
import {PolicyStore} from '../policy/store'

test('public resource bridge: real split PG, held policy locks, exact quota and final source fence',async t=>{
 const urls=isolatedResourceUrls(),app=new Pool({connectionString:urls.app,max:1}),workspace=new Pool({connectionString:urls.workspace,max:1}),control=new Pool({connectionString:urls.app,max:3}),members=new Pool({connectionString:urls.workspace,max:3})
 await app.query('CREATE TABLE IF NOT EXISTS resource_execution_probe(id uuid PRIMARY KEY,owner_id text NOT NULL,workspace_id uuid NOT NULL,lease_until timestamptz NOT NULL,cancelled boolean NOT NULL DEFAULT false,executions int NOT NULL DEFAULT 0)')
 const server=createServer(async(req,res)=>{
  let body='';for await(const d of req)body+=d
  const input=JSON.parse(body)
  await control.query('UPDATE resource_execution_probe SET executions=executions+1 WHERE id=$1',[input.operationId])
  if(input.reject){res.writeHead(input.reject,{'retry-after':'1'}).end('{}');return}
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,usage:{inputTokens:3,outputTokens:7}}))
 })
 server.listen(0,'127.0.0.1');await once(server,'listening')
 const address=server.address();assert.ok(address&&typeof address==='object')
 const send:typeof fetch=(_url,init)=>fetch(`http://127.0.0.1:${address.port}/model`,init)
 const policy=new PolicyStore(workspace,fixtureSigner())
 const engine=new ResourceModelExecution(app,policy,send)
 async function fixture(managed=true){
  const f=await resourceFixture(app,workspace,undefined,managed)
  await app.query("INSERT INTO resource_execution_probe(id,owner_id,workspace_id,lease_until) VALUES($1,$2,$3,clock_timestamp()+interval '5 minutes')",[f.operationId,f.owner,f.workspaceId])
  const scope:ModelExecutionScope={ownerId:f.owner,workspaceId:f.workspaceId,operationId:f.operationId,generation:0,stepKey:'first-model-step',resource:'coordinator.model',binding:{version:1}}
  const fence:ModelSourceFence=async tx=>{
   const r=(await tx.query('SELECT * FROM resource_execution_probe WHERE id=$1 FOR SHARE',[f.operationId])).rows[0]
   if(!r||r.cancelled||r.owner_id!==f.owner||r.workspace_id!==f.workspaceId||r.lease_until<=new Date())throw new Error('sourceLeaseLost')
  }
  return {...f,scope,fence}
 }
 const state=async(owner:string)=>(await control.query('SELECT state,settled_units,units,expires_at FROM quota_reservations WHERE owner_id=$1 ORDER BY created_at',[owner])).rows
 const calls=async(id:string)=>(await control.query('SELECT executions FROM resource_execution_probe WHERE id=$1',[id])).rows[0].executions
 const run=(f:Awaited<ReturnType<typeof fixture>>,extra:{reject?:number;before?:()=>Promise<void>;step?:string}={})=>engine.run({...f.scope,stepKey:extra.step??f.scope.stepKey},AGENT_ROUTE,async(fetch,signal)=>{
  await extra.before?.()
  const response=await fetch(AGENT_ROUTE.endpoint,{method:'POST',signal,body:JSON.stringify({model:AGENT_ROUTE.model,operationId:f.operationId,reject:extra.reject})})
  return response.json() as Promise<{usage:{inputTokens:number;outputTokens:number}}>
 },{fence:f.fence,timeoutMs:1000,leaseMs:5000,usage:v=>v.usage})
 try{
  await t.test('missing legacy adapter still denies; inspection spends zero; ten duplicate actual requests execute once',async()=>{
   const f=await fixture()
   await assert.rejects(authorizeModelRequest(policy,f.owner,AGENT_ROUTE),/policyBudgetUnavailable/)
   for(let n=0;n<10;n++)await engine.available(f.scope,AGENT_ROUTE)
   assert.equal((await state(f.owner)).length,0)
   const result=await Promise.allSettled(Array.from({length:10},()=>run(f)))
   assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(await calls(f.operationId),1)
   assert.deepEqual((await state(f.owner)).map(x=>x.state),['settled'])
   await assert.rejects(run(f),/quotaAlreadyDispatched/);assert.equal(await calls(f.operationId),1)
  })
  await t.test('policy revocation after availability denies before quota/send',async()=>{
   const f=await fixture();await engine.available(f.scope,AGENT_ROUTE)
   await f.policy.publish(f.workspaceId,f.owner,1,{...f.document,state:'revoked'})
   await assert.rejects(run(f),/policyRevoked/);assert.equal(await calls(f.operationId),0);assert.equal((await state(f.owner)).length,0)
  })
  await t.test('captured workspace cannot spend a different owner-bound tenant',async()=>{
   const f=await fixture(),other=randomUUID()
   await workspace.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'other real membership\')',[other,f.owner])
   await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,\'admin\')',[other,f.owner,`${f.owner}@example.invalid`])
   await assert.rejects(engine.available({...f.scope,workspaceId:other},AGENT_ROUTE),/quotaAccessDenied/)
   await assert.rejects(engine.run({...f.scope,workspaceId:other},AGENT_ROUTE,async()=>({}),{fence:f.fence}),/quotaAccessDenied/)
   assert.equal(await calls(f.operationId),0);assert.equal((await state(f.owner)).length,0)
  })
  await t.test('pause, expired reservation and cancelled source at the actual fetch fence refund proven unsent calls',async()=>{
   for(const mode of ['pause','expiry','source']){
    const f=await fixture()
    await assert.rejects(run(f,{before:async()=>{
     if(mode==='pause')await control.query('UPDATE quota_tenants SET paused=true WHERE workspace_id=$1',[f.workspaceId])
     if(mode==='expiry')await control.query("UPDATE quota_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1",[f.owner])
     if(mode==='source')await control.query('UPDATE resource_execution_probe SET cancelled=true WHERE id=$1',[f.operationId])
    }}),/quotaPaused|quotaLeaseLost|modelNotSent/)
    assert.equal(await calls(f.operationId),0)
    const rows=await state(f.owner);assert.equal(rows.length,1);assert.equal(rows[0].state,'refunded');assert.equal(rows[0].settled_units,'0')
   }
  })
  await t.test('first explicit 429 refunds only its own reservation; earlier successful work remains charged',async()=>{
   const first=await fixture();await assert.rejects(run(first,{reject:429}),/modelProviderRejected/)
   assert.equal((await state(first.owner))[0].state,'refunded')
   const multi=await fixture();await run(multi);await assert.rejects(run(multi,{reject:429,step:'second-model-step'}),/modelProviderRejected/)
   assert.deepEqual((await state(multi.owner)).map(x=>[x.state,x.settled_units]),[['settled','2'],['refunded','0']])
   assert.equal(await calls(multi.operationId),2)
  })
  await t.test('unknown transport/body outcome stays fully charged, bounded and never sent again',async()=>{
   const f=await fixture()
   let sent=0
   const stalled=new ResourceModelExecution(app,policy,async()=>{sent++;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'))},cancel(){return new Promise(()=>{})}}))})
   const start=Date.now()
   const invoke=()=>stalled.run(f.scope,AGENT_ROUTE,async(fetch)=>{const r=await fetch(AGENT_ROUTE.endpoint,{method:'POST',body:JSON.stringify({model:AGENT_ROUTE.model})});return r.json()},{fence:f.fence,timeoutMs:500,leaseMs:5000})
   await assert.rejects(invoke(),/timeout|abort/i);assert.equal(sent,1);assert.ok(Date.now()-start<1500)
   const row=(await state(f.owner))[0];assert.equal(row.state,'uncertain');assert.equal(row.settled_units,'2')
   await assert.rejects(invoke(),/quotaOutcomeUncertain/)
  })
  await t.test('web shares the canonical ledger; managed policy denies, cache reads are free and duplicates send once',async()=>{
   const managed=await fixture(),free=await fixture(false)
   const web=(f:typeof free)=>({...f.scope,resource:'web.scrape' as const,stepKey:'web:stable-url'})
   const opts=(f:typeof free)=>({fence:f.fence,preflight:async(tx:import('pg').PoolClient,ws:import('../policy/sql-client').PolicyClient,deadline:Date)=>f.fence(tx,{workspace_id:f.workspaceId} as import('../quota/store').Reservation,deadline,ws),timeoutMs:1000,leaseMs:5000})
   const call=(f:typeof free)=>engine.runTool(web(f),async send=>{
    const r=await send('https://api.firecrawl.dev/v2/scrape',{method:'POST',credentials:'omit',body:JSON.stringify({operationId:f.operationId,url:'https://fixture.public.invalid/page'})})
    return r.json()
   },opts(f))
   await assert.rejects(call(managed),/toolEnforcementUnavailable/)
   assert.equal(await calls(managed.operationId),0);assert.equal((await state(managed.owner)).length,0)
   assert.deepEqual(await engine.runTool(web(free),async()=>({cached:true}),opts(free)),{cached:true})
   assert.equal((await state(free.owner)).length,0)
   const results=await Promise.allSettled(Array.from({length:10},()=>call(free)))
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(await calls(free.operationId),1)
   assert.deepEqual((await state(free.owner)).map(r=>[r.state,r.settled_units]),[['settled','1']])
   await members.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[free.workspaceId,free.owner])
   await assert.rejects(engine.runTool(web(free),async()=>({cached:true}),opts(free)),/policyAccessDenied/)
   assert.equal(await calls(free.operationId),1)
  })
  await t.test('membership withdrawal stays denied without an enterprise management adapter',async()=>{
   const f=await fixture();await members.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[f.workspaceId,f.owner])
   await assert.rejects(run(f),/policyAccessDenied/);assert.equal(await calls(f.operationId),0)
  })
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await Promise.all([app.end(),workspace.end(),control.end(),members.end()])}
})
