import assert from 'node:assert/strict'
import test from 'node:test'
import { NEON_PROJECT, neonUsage, summarize, run, publish } from './egress-monitor.mjs'
const now = Date.parse('2026-11-03T12:15:00Z')
const usage = (bytes=1000) => ({projects:[{project_id:NEON_PROJECT,periods:[{period_start:'2026-11-03T10:56:54Z',period_plan:'launch',consumption:[{timeframe_start:'2026-11-03T11:00:00Z',timeframe_end:'2026-11-03T12:00:00Z',metrics:[{metric_name:'public_network_transfer_bytes',value:bytes}]}]}]}]})
test('provider usage respects billing resets; missing and stale data never become healthy zero',()=>{
  const actual=neonUsage(usage(),now)
  assert.equal(actual.periodBytes,1000);assert.equal(actual.stale,false)
  assert.equal(neonUsage(usage(),now+4*3600000).stale,true)
  assert.throws(()=>neonUsage({projects:[]},now))
  assert.throws(()=>neonUsage(usage(-1),now))
  const reset=usage();reset.projects[0].periods.push({...reset.projects[0].periods[0],period_start:'2026-10-01T00:00:00Z',period_end:'2026-11-03T10:56:54Z'})
  assert.equal(neonUsage(reset,now).periodBytes,1000)
})
test('sample estimates stay separate from billed bytes; reports exclude raw data',()=>{
  const sample={msg:'db_sample',timestamp:new Date(now-1000).toISOString(),sampleRate:.01,statement:'abc123def456',route:'/actions/issues/poll',rows:100,bytes:20000,sql:'PRIVATE',body:'PRIVATE'}
  const request={msg:'api_request',timestamp:sample.timestamp,invocationId:'i',route:'/api/test',status:500,body:'PRIVATE'}
  const events=[{deploymentId:'dpl_test',environment:'production',message:[sample,request,request].map(e=>JSON.stringify(e)).join('\n')}]
  const report=summarize(events,'dpl_test',now)
  assert.equal(report.queries[0].estimatedBytes,2000000);assert.equal(report.sampledBytes,20000)
  assert.equal(report.requests[0].count,1);assert.equal(report.requests[0].errors,1)
  assert.ok(!JSON.stringify(report).includes('PRIVATE'))
  assert.throws(()=>summarize(events,'dpl_other',now))
  assert.equal(summarize([{...events[0],truncated:true}],'dpl_test',now).truncated,1)
})
test('missing inputs publish unhealthy coverage, never successful zero; delivery failure rejects',async()=>{
  const report=await run({now})
  assert.equal(report.status,'insufficient');assert.ok(report.reasons.includes('neon_token_unavailable'))
  let payload
  await publish(report,'public-ingestion-token',async(url,options)=>{
    assert.equal(url,'https://us.i.posthog.com/batch/');assert.equal(options.redirect,'error')
    payload=JSON.parse(options.body);return new Response('{}',{status:200})
  })
  assert.equal(payload.batch[0].properties.collection_healthy,0)
  assert.equal(payload.batch[0].properties.period_bytes,undefined)
  await assert.rejects(()=>publish(report,'token',async()=>new Response(null,{status:503})),/telemetry_delivery_failed/)
})

test('minute-cron provider fallback never requires Vercel privileges or invents runtime samples',async()=>{
  const report=await run({now,providerOnly:true,neonToken:'fixture-private-key',fetchImpl:async(url,options)=>{
    assert.equal(new URL(url).hostname,'console.neon.tech');assert.equal(options.redirect,'error')
    return Response.json(usage())
  }})
  assert.equal(report.status,'ok');assert.equal(report.neon.latestHourBytes,1000)
  assert.equal(report.runtime,undefined);assert.equal(report.collectionScope,'provider')
  let payload
  await publish(report,'public-ingestion-key',async(_url,options)=>{payload=JSON.parse(options.body);return Response.json({})})
  assert.equal(payload.batch[0].properties.collection_healthy,1)
  assert.equal(payload.batch[0].properties.collection_scope,'provider')
  assert.equal(payload.batch[0].properties.collector_source,'cloudflare_provider_fallback')
  assert.equal(payload.batch[0].properties.provider_healthy,1)
  assert.equal(payload.batch[0].properties.samples,undefined)
  assert.equal(payload.batch[0].properties.sampled_bytes,undefined)
  assert.equal(payload.batch[0].properties.request_count,undefined)
  assert.ok(!JSON.stringify(payload).includes('fixture-private-key'))
  const failed=await run({now,providerOnly:true,neonToken:'fixture-private-key',fetchImpl:async()=>new Response(null,{status:503})})
  await publish(failed,'public-ingestion-key',async(_url,options)=>{payload=JSON.parse(options.body);return Response.json({})})
  assert.equal(payload.batch[0].properties.collection_healthy,0)
  assert.equal(payload.batch[0].properties.latest_hour_bytes,undefined)
})

test('large-result census and random small samples retain separate inclusion weights',()=>{
  const common={msg:'db_sample',timestamp:new Date(now-1000).toISOString(),statement:'abc123def456',route:'/actions/coordinator/poll',rows:1}
  const events=[{deploymentId:'dpl_test',environment:'production',message:[
    {...common,sampleRate:.01,bytes:100},
    {...common,sampleRate:1,bytes:100000},
  ].map(e=>JSON.stringify(e)).join('\n')}]
  const report=summarize(events,'dpl_test',now)
  assert.equal(report.queries[0].samples,2)
  assert.equal(report.queries[0].estimatedBytes,110000)
  assert.equal(report.sampledBytes,100100)
})

test('real collector contract combines closed daily usage and current-day hourly usage without double counting',async()=>{
  const alias={alias:'app.aspectlylabs.com',projectId:'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH',deploymentId:'dpl_test',updatedAt:1}
  const sample={msg:'db_sample',timestamp:new Date(now-1000).toISOString(),sampleRate:.01,statement:'abc123def456',route:'/actions/issues/poll',rows:1,bytes:100}
  const fetchImpl=async (raw,options)=>{
    const url=new URL(raw)
    assert.equal(options.redirect,'error')
    if(url.hostname==='api.vercel.com'){
      if(url.pathname.includes('/aliases/'))return Response.json(alias)
      return Response.json({events:[{deploymentId:'dpl_test',environment:'production',message:JSON.stringify(sample)}],pagination:{hasMore:false,nextCursor:null}})
    }
    if(url.searchParams.get('granularity')==='daily')return Response.json({projects:[]})
    return Response.json(usage(1000))
  }
  const report=await run({vercelToken:'v',neonToken:'n',now,fetchImpl})
  assert.equal(report.status,'ok');assert.equal(report.neon.periodBytes,1000)
  assert.equal(report.neon.latestHourBytes,1000)
  assert.equal(report.runtime.samples,1)
  const excluded=await run({vercelToken:'v',neonToken:'n',now,fetchImpl:async(url,options)=>{
    const response=await fetchImpl(url,options)
    if(new URL(url).pathname==='/v1/observability/events'){
      const body=await response.json();body.meta={excludedIntervals:[{}]};return Response.json(body)
    }
    return response
  }})
  assert.equal(excluded.status,'insufficient');assert.ok(excluded.reasons.includes('log_intervals_excluded'))
  const aged=await run({vercelToken:'v',neonToken:'n',now:now+4*3600000,fetchImpl})
  assert.ok(aged.reasons.includes('neon_usage_stale'))
})
