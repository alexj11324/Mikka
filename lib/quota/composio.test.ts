import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {createServer,type ServerResponse} from 'node:http'
import {once} from 'node:events'
import {setTimeout as delay} from 'node:timers/promises'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import test from 'node:test'
import {Pool} from 'pg'
import {Composio} from '@composio/core'
import {QuotaStore} from './store'
import {configureQuota,quotaPolicySchema} from './config'
import {budgetedComposioAction} from './composio'
const target=process.env.QUOTA_TEST_DATABASE_URL
if(target){const u=new URL(target);assert.ok(['localhost','127.0.0.1','[::1]'].includes(u.hostname));assert.match(u.pathname,/(?:_e2e|_quota215)$/)}
const account={id:'synthetic-account',auth_config:{id:'synthetic-config',is_composio_managed:true,is_disabled:false},toolkit:{slug:'notion'},status:'ACTIVE',status_reason:null,is_disabled:false,created_at:'2026-10-25T00:00:00Z',updated_at:'2026-10-25T00:00:00Z'}
const tool={slug:'NOTION_SEARCH_NOTION_PAGE',name:'Synthetic Notion search',toolkit:{slug:'notion',name:'Notion'},version:'20261018_00',input_parameters:{type:'object',properties:{query:{type:'string'}}},output_parameters:{type:'object',properties:{}}}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return{promise,resolve}}
function json(res:ServerResponse,body:unknown){if(!res.destroyed){res.setHeader('content-type','application/json');res.end(JSON.stringify(body))}}

test('real Composio SDK HTTP preflight, lease fencing and transport cancellation',{skip:!target,timeout:30000},async t=>{
 const network=join(tmpdir(),`quota-sdk-network-${randomUUID()}.jsonl`);await writeFile(network,'');process.env.QUOTA_NETWORK_EVIDENCE=network
 await import('../../tests/fixtures/quota-network-guard.mjs')
 const admin=new Pool({connectionString:target,max:1}),schema=`composio_quota_${randomUUID().replaceAll('-','')}`
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const url=new URL(target!);url.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:url.toString(),max:8})
 const store=new QuotaStore(pool,async(owner,workspace)=>Boolean((await pool.query('SELECT 1 FROM quota_test_members WHERE owner_id=$1 AND workspace_id=$2',[owner,workspace])).rowCount))
 const evidence:{sha:string;utc:string;schema:string;cases:Record<string,unknown>[];blockedNetworkAttempts?:unknown[]}={sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),utc:new Date().toISOString(),schema,cases:[]}
 try{
  await pool.query('CREATE TABLE agent_runs(id uuid PRIMARY KEY)')
  await pool.query(await readFile(new URL('../../drizzle/20261025165100_tenant_quotas.sql',import.meta.url),'utf8'))
  await pool.query('CREATE TABLE quota_test_members(owner_id text PRIMARY KEY,workspace_id uuid NOT NULL)')
  await pool.query('CREATE TABLE quota_test_effects(id uuid PRIMARY KEY,service_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp())')
  const fixture=async()=>{const owner=randomUUID(),workspace=randomUUID(),resources={'composio.action':{units:1,unknownCostApproved:true}}
   const policy=quotaPolicySchema.parse({windowStart:new Date(Date.now()-60000).toISOString(),windowEnd:new Date(Date.now()+3600000).toISOString(),budgetUnits:10,concurrencyLimit:1,rateLimit:100,rateWindowSeconds:60,resources,owners:[owner],paused:false,override:null})
   await pool.query(`INSERT INTO quota_allocations(workspace_id,max_budget_units,max_concurrency,max_rate_limit,rate_window_seconds,resources,expires_at,granted_by,reason) VALUES($1,10,1,100,60,$2,now()+interval '2 hours','test-operator','controlled SDK HTTP fixture')`,[workspace,resources])
   await configureQuota(pool,workspace,owner,policy);await pool.query('INSERT INTO quota_test_members VALUES($1,$2)',[owner,workspace]);return{owner,workspace,key:randomUUID()}}
  async function service(beforeAccounts?:(res:ServerResponse)=>Promise<void>, beforeExecutionResponse?:()=>Promise<void>, beforeSchema?:(count:number)=>Promise<void>, rejectExecution?:number){const requests:string[]=[],effects:{at:string}[]=[],id=randomUUID();let schemaRequests=0
   const server=createServer(async(req,res)=>{
    requests.push(`${req.method} ${req.url}`)
    if(req.url?.includes('connected_accounts')){await beforeAccounts?.(res);json(res,{items:[account],next_cursor:null,total_pages:1});return}
    if(req.method==='POST'&&req.url?.includes('execute')){if(rejectExecution){res.statusCode=rejectExecution;res.setHeader('retry-after','30');json(res,{error:{message:'synthetic provider rejection'}});return}await pool.query('INSERT INTO quota_test_effects(id,service_id) VALUES($1,$2)',[randomUUID(),id]);effects.push({at:new Date().toISOString()});await beforeExecutionResponse?.();json(res,{data:{synthetic:true},successful:true,error:null,log_id:'synthetic-log'});return}
    if(req.method==='GET'&&req.url?.includes('tools')){await beforeSchema?.(++schemaRequests);json(res,tool);return}
    res.statusCode=404;json(res,{error:'unknown synthetic endpoint'})
   });server.listen(0,'127.0.0.1');await once(server,'listening')
   const client=new Composio({apiKey:'synthetic-no-provider-access',userApiKey:null,orgApiKey:null,baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}`,allowTracking:false,disableVersionCheck:true})
   return{id,client,requests,effects,async close(){server.closeAllConnections();const closed=once(server,'close');server.close();await closed}}}
  await t.test('positive control uses the real SDK and one loopback execution',async()=>{
   const f=await fixture(),s=await service()
   try{const result=await budgetedComposioAction(store,f.owner,'search_notion_pages',{query:'synthetic'},()=>s.client,f.key,{leaseMs:5000,timeoutMs:4500});evidence.cases.push({name:'positive control',result,requests:s.requests,effects:s.effects});assert.ok('data'in result,JSON.stringify(evidence.cases.at(-1)));assert.equal(s.effects.length,1)}finally{await s.close()}
  })
  await t.test('late preflight cannot send after another request expires its reservation',async()=>{
   const f=await fixture(),received=deferred(),release=deferred(),s=await service(async()=>{received.resolve();await release.promise})
   try{
    const pending=budgetedComposioAction(store,f.owner,'search_notion_pages',{query:'synthetic delayed'},()=>s.client,f.key,{leaseMs:5000,timeoutMs:4500})
    await received.promise
    const old=(await pool.query('SELECT id,state FROM quota_reservations WHERE owner_id=$1 AND request_key=$2',[f.owner,f.key])).rows[0]
    await pool.query("UPDATE quota_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[old.id])
    const competitor=await store.reserve({ownerId:f.owner,key:randomUUID(),resource:'composio.action',binding:{competitor:true}});await store.activate(f.owner,competitor.id)
    release.resolve();const result=await pending
    const state=(await pool.query('SELECT state,settled_units FROM quota_reservations WHERE id=$1',[old.id])).rows[0]
    evidence.cases.push({name:'late preflight',result,oldBefore:old,oldAfter:state,competitor:competitor.id,requests:s.requests,effects:s.effects})
    assert.equal(s.effects.length,0,'expired preflight must never dispatch a tool HTTP request')
    assert.ok('error'in result);assert.equal(state.state,'uncertain');assert.equal(state.settled_units,'1')
   }finally{release.resolve();await s.close()}
  })
  await t.test('SDK-internal schema preflight is fenced at its final beforeExecute hook',async()=>{
   const f=await fixture(),received=deferred(),release=deferred(),s=await service(undefined,undefined,async count=>{if(count===2){received.resolve();await release.promise}})
   try{
    const pending=budgetedComposioAction(store,f.owner,'search_notion_pages',{query:'synthetic hidden schema delay'},()=>s.client,f.key,{leaseMs:5000,timeoutMs:4500})
    await received.promise
    const old=(await pool.query('SELECT id FROM quota_reservations WHERE owner_id=$1 AND request_key=$2',[f.owner,f.key])).rows[0]
    await pool.query("UPDATE quota_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[old.id])
    const competitor=await store.reserve({ownerId:f.owner,key:randomUUID(),resource:'composio.action',binding:{competitor:true}});await store.activate(f.owner,competitor.id)
    release.resolve();const result=await pending
    const effectCount=Number((await pool.query('SELECT count(*) n FROM quota_test_effects WHERE service_id=$1',[s.id])).rows[0].n)
    evidence.cases.push({name:'SDK schema preflight',result,requests:s.requests,effectCount})
    assert.equal(effectCount,0);assert.deepEqual(result,{error:'quotaLeaseLost'})
   }finally{release.resolve();await s.close()}
  })
  await t.test('deadline aborts actual preflight transport, with no late execution continuation',async()=>{
   const f=await fixture(),lateResponse=deferred();let closedBeforeResponse=false
   const s=await service(async res=>{res.on('close',()=>{if(!res.writableEnded)closedBeforeResponse=true});await delay(1500);lateResponse.resolve()})
   try{
    const result=await budgetedComposioAction(store,f.owner,'search_notion_pages',{query:'synthetic deadline'},()=>s.client,f.key,{leaseMs:5000,timeoutMs:1000})
    await lateResponse.promise;await delay(30)
    const state=(await pool.query('SELECT state,settled_units FROM quota_reservations WHERE owner_id=$1 AND request_key=$2',[f.owner,f.key])).rows[0]
    evidence.cases.push({name:'transport deadline',result,closedBeforeResponse,state,requests:s.requests,effects:s.effects})
    assert.equal(s.effects.length,0);assert.equal(closedBeforeResponse,true,'AbortSignal must cancel the real HTTP socket')
    assert.ok('error'in result);assert.equal(state.state,'refunded');assert.equal(state.settled_units,'0')
   }finally{await s.close()}
  })
  await t.test('deadline cancels a response body stalled after actual HTTP headers',async()=>{
   const f=await fixture(),lateResponse=deferred();let closedBeforeResponse=false
   const s=await service(async res=>{
    res.setHeader('content-type','application/json');res.writeHead(200);res.write('{"items":')
    res.on('close',()=>{if(!res.writableEnded)closedBeforeResponse=true})
    await delay(1500);lateResponse.resolve()
   })
   try{
    const started=Date.now()
    const result=await budgetedComposioAction(store,f.owner,'search_notion_pages',{query:'synthetic stalled body'},()=>s.client,f.key,{leaseMs:5000,timeoutMs:1000})
    const duration=Date.now()-started
    await lateResponse.promise;await delay(30)
    const state=(await pool.query('SELECT state,settled_units FROM quota_reservations WHERE owner_id=$1 AND request_key=$2',[f.owner,f.key])).rows[0]
    evidence.cases.push({name:'headers then stalled body',result,duration,closedBeforeResponse,state,requests:s.requests,effects:s.effects})
    assert.equal(closedBeforeResponse,true,'whole-operation deadline must cancel body I/O after headers')
    assert.equal(s.effects.length,0);assert.equal(s.requests.some(r=>r.startsWith('POST')),false)
    assert.deepEqual(result,{error:'integrationTimedOut'});assert.deepEqual(state,{state:'refunded',settled_units:'0'})
   }finally{await s.close()}
  })
  await t.test('actual SDK-wrapped HTTP 429 refunds and persists shared Retry-After without retry',async()=>{
   const f=await fixture(),s=await service(undefined,undefined,undefined,429)
   try{
    const result=await budgetedComposioAction(store,f.owner,'search_notion_pages',{query:'synthetic rate rejection'},()=>s.client,f.key,{leaseMs:5000,timeoutMs:4500})
    const state=(await pool.query('SELECT state,settled_units FROM quota_reservations WHERE owner_id=$1 AND request_key=$2',[f.owner,f.key])).rows[0]
    const retry=await budgetedComposioAction(store,f.owner,'search_notion_pages',{query:'synthetic subsequent request'},()=>s.client,randomUUID(),{leaseMs:5000,timeoutMs:4500})
    const backoff=(await pool.query('SELECT retry_at>clock_timestamp() AS active FROM quota_backoffs WHERE workspace_id=$1',[f.workspace])).rows[0]
    evidence.cases.push({name:'SDK wrapped HTTP 429',result,retry,state,backoff,requests:s.requests,effects:s.effects})
    assert.equal(s.effects.length,0);assert.equal(state.state,'refunded');assert.equal(state.settled_units,'0');assert.deepEqual(retry,{error:'providerBackoff'});assert.equal(backoff?.active,true)
    assert.equal(s.requests.filter(r=>r.startsWith('POST')).length,1,'SDK and wrapper must not retry the rejection')
   }finally{await s.close()}
  })
  await t.test('an invoked HTTP effect with a lost response remains uncertain and cannot resend',async()=>{
   const f=await fixture(),executed=deferred(),release=deferred(),controller=new AbortController()
   const s=await service(undefined,async()=>{executed.resolve();await release.promise})
   let pending:ReturnType<typeof budgetedComposioAction>|undefined
   try{
    pending=budgetedComposioAction(store,f.owner,'search_notion_pages',{query:'synthetic uncertain effect'},()=>s.client,f.key,{leaseMs:10000,timeoutMs:9000,signal:controller.signal})
    // Test-only stage barrier: always await the operation and release the HTTP
    // handler in finally. The production path never races a background task.
    const reached=await Promise.race([executed.promise.then(()=>true),pending.then(()=>false)])
    assert.equal(reached,true,'controlled effect must happen before response loss is injected')
    controller.abort(new DOMException('Synthetic response loss after effect','TimeoutError'))
    const result=await pending
    const state=(await pool.query('SELECT state,settled_units FROM quota_reservations WHERE owner_id=$1 AND request_key=$2',[f.owner,f.key])).rows[0]
    const replay=await budgetedComposioAction(store,f.owner,'search_notion_pages',{query:'synthetic uncertain effect'},()=>s.client,f.key,{leaseMs:10000,timeoutMs:9000})
    const effectCount=Number((await pool.query('SELECT count(*) n FROM quota_test_effects WHERE service_id=$1',[s.id])).rows[0].n)
    evidence.cases.push({name:'invoked uncertain effect',result,replay,state,effectCount,requests:s.requests})
    assert.equal(effectCount,1);assert.deepEqual(result,{error:'integrationTimedOut'});assert.equal(state.state,'uncertain');assert.equal(state.settled_units,'1');assert.deepEqual(replay,{error:'quotaOutcomeUncertain'})
   }finally{controller.abort();release.resolve();await pending;await s.close()}

  })
 }finally{evidence.blockedNetworkAttempts=(await readFile(network,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));await writeFile('quota-composio-evidence.json',JSON.stringify(evidence,null,2));await pool.end();await admin.end();assert.deepEqual(evidence.blockedNetworkAttempts,[])}
})
