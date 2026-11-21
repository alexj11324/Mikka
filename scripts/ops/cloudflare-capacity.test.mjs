import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {notifyAlerts} from './monitor.mjs'
import {capacityWindow,comparePressure,routeWindow,legacyFilesystemBudget,pressureAnomalies,deliverPressure} from './cloudflare-capacity.mjs'
const app='11111111-1111-4111-8111-111111111111',host='a'.repeat(64),tag='b'.repeat(32),minute=60000,start=Date.UTC(2026,10,12,0),end=start+5*minute
const none={data:{viewer:{accounts:[{usage:[],memory:[]}]}}}
const iso=t=>new Date(t).toISOString()
const basic={applicationId:app,instanceId:host,datetimeFiveMinutes:iso(start)}
const rows={usage:[{dimensions:basic,sum:{cpuTimeSec:12.5,allocatedMemory:123,allocatedDisk:456,txBytes:0}}],
  memory:[{dimensions:basic,max:{memory:71000}}]}
const read=(reply,scope={})=>capacityWindow({application:app,account:tag,start,end,read:async query=>{
 assert.deepEqual(query.variables,{tag,usage:{applicationId:app,datetime_geq:iso(start),datetime_lt:iso(end)},metrics:{applicationId:app,datetime_geq:iso(start),datetime_lt:iso(end)}})
 return reply
},...scope})
const request=(id,route='/api/one',status=200,duration=100,when=start)=>[
 {message:JSON.stringify({msg:'api_request_started',route,invocationId:id,timestamp:iso(when)})},
 {message:JSON.stringify({msg:'api_request',route,invocationId:id,timestamp:iso(when+duration),durationMs:duration,status})}]
function traffic(count,status=200,at=start){return Array.from({length:count},(_,i)=>request('i'+i,'/api/one',status,100,at+i)).flat()}
test('provider scope and units are tied to the same account, application and exact time bounds',async()=>{
 const r=await read({data:{viewer:{accounts:[rows]}}})
 assert.equal(r.status,'observed');assert.equal(r.cpuMs,12500);assert.equal(r.maximumInstanceMemoryBytes,71000)
 assert.equal(r.allocatedMemoryByteSeconds,123);assert.equal(r.instances,1)
 for(const dims of [{applicationId:'22222222-2222-4222-8222-222222222222'},{instanceId:'bad'},{datetimeFiveMinutes:iso(end)}])
   await assert.rejects(read({data:{viewer:{accounts:[{...rows,usage:[{...rows.usage[0],dimensions:{...basic,...dims}}]}]}}}))
 await assert.rejects(read({data:{viewer:{accounts:[{...rows,usage:Array(1000).fill(rows.usage[0])}]}}}))
 await assert.rejects(read({data:{viewer:{accounts:[{...rows,memory:[...rows.memory,...rows.memory]}]}}}))
 assert.deepEqual((await read(none)).reasons,['no_cpu_observations','no_memory_observations'])
 assert.equal((await read({data:{viewer:{accounts:[{...rows,memory:[]}]}}})).status,'insufficient')
})
test('quantiles are from complete, matching routes; errors and missing pairs retain their denominators',()=>{
 const r=routeWindow([...request('1'),...request('2','/api/one',500,1000),request('3')[0]],start,end)
 assert.deepEqual([r.starts,r.requests,r.errors,r.unfinished,r.coverage],[3,2,1,1,2/3])
 assert.deepEqual(r.groups.map(x=>[x.httpStatus,x.p95Ms]),[['200',100],['500',1000]])
 assert.equal(routeWindow([request('x')[0],request('x','/api/two')[1]],start,end).requests,0)
 assert.equal(routeWindow([request('x')[1]],start,end).unmatched,1)
})
test('one physical app CPU delta can fire then recover without assigning it to an individual handler',()=>{
 const w=(when,cpu,items=traffic(20,200,when))=>({capacity:{start:when,end:when+five,status:'observed',cpuMs:cpu},traffic:routeWindow(items,when,when+five)})
 const five=300000,previous=w(start,1000),spike=w(end,8000),steady=w(end+five,1010)
 assert.equal(comparePressure(previous,spike).status,'regression')
 assert.equal(comparePressure(previous,steady).status,'pass')
 assert.equal(comparePressure(previous,w(end,2000)).status,'pass')
 assert.equal(comparePressure(previous,w(end,8000,traffic(19,200,end))).status,'insufficient')
 assert.equal(comparePressure(previous,w(end,1000,[...traffic(20,200,end),request('lost','/api/one',200,100,end)[0]])).status,'insufficient')
 assert.equal(comparePressure(previous,w(end,1000,traffic(20,500,end))).status,'regression')
 assert.throws(()=>comparePressure(previous,previous))
})
test('sampled or dropped filesystem starts cannot establish an upper bound for one device',()=>{
 const route='/v1/devices/[deviceId]/fs/requests'
 const items=n=>Array.from({length:n},(_,i)=>request(String(i),route)).flat()
 const few=items(18)
 assert.deepEqual(legacyFilesystemBudget([...few,...few],start,end),{
  status:'insufficient',reason:'origin_completeness_unverified',requests:18,singleDeviceUpperBound:null,threshold:18})
 assert.deepEqual(legacyFilesystemBudget(items(19),start,end),{
  status:'investigate',reason:'combined_observed_count_above_threshold',requests:19,singleDeviceUpperBound:null,threshold:18})
 const invalid={message:JSON.stringify({msg:'api_request_started',route,timestamp:new Date(start).toISOString()})}
 assert.deepEqual(legacyFilesystemBudget([invalid,...few],start,end),{
  status:'insufficient',reason:'filesystem_coverage_unknown',requests:18,singleDeviceUpperBound:null,threshold:18})
 assert.deepEqual(legacyFilesystemBudget(items(19),end,end+5*minute),{
  status:'insufficient',reason:'no_observed_requests',requests:0,singleDeviceUpperBound:null,threshold:18})
 assert.deepEqual(legacyFilesystemBudget(request('q','/api/one',200,50,end),end,end+5*minute),{
  status:'insufficient',reason:'origin_completeness_unverified',requests:0,singleDeviceUpperBound:null,threshold:18})
})
test('same-app 15-minute anomalies detect fresh pressure and recover; missing history never resolves incidents',()=>{
 const q=15*minute,w=(n,cpu=2000,count=100)=>({capacity:{start:start+n*q,end:start+(n+1)*q,status:'observed',application:app,cpuMs:cpu},
  traffic:{start:start+n*q,end:start+(n+1)*q,coverage:1,unmatched:0,malformed:0,requests:count,starts:count}})
 const baseline=Array.from({length:8},(_,n)=>w(n,2000+n,100+n%2))
 assert.deepEqual(pressureAnomalies(w(8,30000,120),baseline).firing,['requests','cpuMs','cpuMsPerObservedRequest'])
 assert.deepEqual(pressureAnomalies(w(8,3000),baseline).firing,[])
 assert.equal(pressureAnomalies(w(9),[...baseline.slice(1),w(8,30000,120)]).status,'within_baseline')
 const partial=w(8,30000,120);partial.traffic.coverage=.2
 const observed=pressureAnomalies(partial,baseline)
 assert.deepEqual(observed.firing,['cpuMs']);assert.deepEqual(observed.assessed,['cpuMs'])
 assert.equal(pressureAnomalies(w(8),baseline.slice(1)).status,'insufficient')
 assert.equal(pressureAnomalies(w(9),baseline).status,'insufficient')
})
test('existing HTTP notifier fires, refuses unknown recovery, retries failed delivery and resolves a verified value',async()=>{
 const received=[]
 let status=503
 const local=createServer(async(req,res)=>{
  let payload=''
  for await(const chunk of req)payload+=chunk
  if(status===200)received.push(JSON.parse(payload))
  res.writeHead(status).end()
 })
 local.listen(0,'127.0.0.1');await once(local,'listening')
 try{
  const sink='http://127.0.0.1:'+local.address().port
  const high={assessed:['cpuMs'],firing:['cpuMs'],values:{cpuMs:{value:100000}}},good={assessed:['cpuMs'],firing:[],values:{cpuMs:{value:2100}}}
  const run=(result,state,at)=>deliverPressure(result,{state,sink,now:at,notify:notifyAlerts})
  let value=await run(high,{},start)
  assert.equal(value.healthy,false);assert.equal(received.length,0)
  status=200;value=await run(high,value.state,start+1)
  assert.equal(value.healthy,true);assert.equal(received.length,1)
  value=await run(high,value.state,start+2)
  value=await run({assessed:[],firing:[],values:{}},value.state,start+3)
  assert.equal(received.length,1);assert.equal(value.state['cloudflare-api-cpu'].active,true)
  value=await run(good,value.state,start+4)
  assert.equal(value.state['cloudflare-api-cpu'].active,false)
  assert.deepEqual(received.map(x=>[x.id,x.state]),[['cloudflare-api-cpu','firing'],['cloudflare-api-cpu','resolved']])
 }finally{local.closeAllConnections();await new Promise(resolve=>local.close(resolve))}
})
