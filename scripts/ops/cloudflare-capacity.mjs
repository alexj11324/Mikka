import { POLICY } from './deployment-regression.mjs'

const fiveMinutes = 300_000
const limit = 1000
const instance = /^[a-f0-9]{64}$/
const fail = code => { throw Error(code) }
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const iso = value => new Date(value).toISOString()
const quantile = (values, p) => values.length ? values[Math.ceil(p * values.length) - 1] : null
const routeTemplate = /^\/[A-Za-z0-9_./[\]()-]{0,250}$/
const dateMatch = (timestamp, start, end) => start <= timestamp && timestamp < end

export const capacityQuery = 'query($tag:String!, $usage:AccountContainersUsageAdaptiveGroupsFilter_InputObject!, $metrics:AccountContainersMetricsAdaptiveGroupsFilter_InputObject!) { viewer { accounts(filter:{accountTag:$tag}) { usage:containersUsageAdaptiveGroups(filter:$usage,limit:1000){dimensions{applicationId instanceId datetimeFiveMinutes} sum{cpuTimeSec allocatedMemory allocatedDisk txBytes}} memory:containersMetricsAdaptiveGroups(filter:$metrics,limit:1000){dimensions{applicationId instanceId datetimeFiveMinutes} max{memory}} } } }'

/** Usage counts CPU for the application. Memory is a high-water mark per
 * instance, never a sum of asynchronous peaks or an invoice estimate. */
export async function capacityWindow({ application, account, start, end, read }) {
  const app=application
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(app))fail('capacity_application_invalid')
  if(!/^[a-f0-9]{32}$/.test(account)||![start,end].every(x=>Number.isSafeInteger(x)&&x%fiveMinutes===0) ||
    end<=start||end-start>15*60_000)fail('capacity_window_invalid')
  const filter={applicationId:app,datetime_geq:iso(start),datetime_lt:iso(end)}
  const response=await read({query:capacityQuery,variables:{tag:account,usage:filter,metrics:filter}})
  const accounts=response?.data?.viewer?.accounts
  if(response?.errors?.length||accounts?.length!==1)fail('capacity_provider_unavailable')
  const {usage,memory}=accounts[0]
  if(![usage,memory].every(rows=>Array.isArray(rows)&&rows.length<limit))fail('capacity_rows_incomplete')
  const group=row=>{
    const d=row.dimensions,at=Date.parse(d?.datetimeFiveMinutes)
    if(d?.applicationId!==app||!instance.test(d.instanceId)||!dateMatch(at,start,end)||at%fiveMinutes!==0)
      fail('capacity_row_scope_invalid')
    return at+'/'+d.instanceId
  }
  const instances=new Map(),usageKeys=new Set(),memoryKeys=new Set()
  let cpuMs=0,allocatedMemoryByteSeconds=0,egressBytes=0
  for(const row of usage){
    const key=group(row),{instanceId}=row.dimensions,v=row.sum
    if(usageKeys.has(key)||![v?.cpuTimeSec,v?.allocatedMemory,v?.allocatedDisk,v?.txBytes].every(number)) fail('capacity_usage_invalid')
    usageKeys.add(key)
    const inst=instances.get(instanceId)??{cpuMs:0,peakMemoryBytes:null}
    inst.cpuMs+=v.cpuTimeSec*1000
    instances.set(instanceId,inst)
    cpuMs+=v.cpuTimeSec*1000;allocatedMemoryByteSeconds+=v.allocatedMemory;egressBytes+=v.txBytes
  }
  for(const row of memory){
    const key=group(row),{instanceId}=row.dimensions
    if(memoryKeys.has(key)||!number(row.max?.memory))fail('capacity_memory_invalid')
    memoryKeys.add(key)
    const inst=instances.get(instanceId)??{cpuMs:null,peakMemoryBytes:null}
    inst.peakMemoryBytes=Math.max(inst.peakMemoryBytes??0,row.max.memory)
    instances.set(instanceId,inst)
  }
  const reasons=[]
  if(!usage.length)reasons.push('no_cpu_observations')
  if(!memory.length)reasons.push('no_memory_observations')
  const observedBuckets=new Set(usage.map(row=>row.dimensions.datetimeFiveMinutes)).size
  if(usage.length&&observedBuckets!==(end-start)/fiveMinutes)reasons.push('provider_time_buckets_missing')
  if(usageKeys.size!==memoryKeys.size||[...usageKeys].some(key=>!memoryKeys.has(key)))reasons.push('instance_metric_coverage_differs')
  const windows=[]
  for(let at=start;at<end;at+=fiveMinutes){
    const matches=row=>Date.parse(row.dimensions.datetimeFiveMinutes)===at
    const used=usage.filter(matches),peaks=memory.filter(matches),keys=new Set(used.map(group))
    const complete=used.length>0&&used.length===peaks.length&&peaks.every(row=>keys.has(group(row)))
    windows.push({application:app,start:at,end:at+fiveMinutes,status:complete?'observed':'insufficient',
      instances:keys.size,cpuMs:used.length?used.reduce((n,row)=>n+1000*row.sum.cpuTimeSec,0):null,
      maximumInstanceMemoryBytes:peaks.length?Math.max(...peaks.map(row=>row.max.memory)):null})
  }
  return {windows,scope:'container_application_and_instances',application:app,start,end,status:reasons.length?'insufficient':'observed',
    reasons,instances:instances.size,observedFiveMinuteBuckets:observedBuckets,usageGroups:usage.length,memoryGroups:memory.length,cpuMs:usage.length?cpuMs:null,
    allocatedMemoryByteSeconds:usage.length?allocatedMemoryByteSeconds:null,egressBytes:usage.length?egressBytes:null,
    maximumInstanceMemoryBytes:memory.length?Math.max(...memory.map(x=>x.max.memory)):null}
}

/** Raw invocation IDs pair starts with their own completions only in memory.
 * The output contains route templates, status counts and latency quantiles. */
export function routeWindow(events,start,end){
  const starts=new Map(),ends=new Map(),groups=new Map()
  let malformed=0
  for(const event of events){
    const value=JSON.parse(event.message)
    if(!['api_request_started','api_request'].includes(value.msg))continue
    const at=Date.parse(value.timestamp)
    if(!dateMatch(at,start,end))continue
    if(!routeTemplate.test(value.route)||typeof value.invocationId!=='string'||!value.invocationId){malformed++;continue}
    const map=value.msg==='api_request'?ends:starts
    if(map.has(value.invocationId)){malformed++;continue}
    if(value.msg==='api_request'&&(!Number.isSafeInteger(value.status)||value.status<100||value.status>599||!number(value.durationMs))){malformed++;continue}
    map.set(value.invocationId,value)
  }
  let paired=0,unfinished=0,errors=0,unmatched=0
  for(const [id,begin] of starts){
    const finish=ends.get(id)
    if(!finish||finish.route!==begin.route||Date.parse(finish.timestamp)<Date.parse(begin.timestamp)){
      unfinished++;continue
    }
    paired++
    if(finish.status>=500)errors++
    const key=JSON.stringify([begin.route,finish.status])
    let group=groups.get(key)
    if(!group){group={route:begin.route,status:finish.status,latencies:[]};groups.set(key,group)}
    group.latencies.push(finish.durationMs)
  }
  for(const [id,row] of ends)if(starts.get(id)?.route!==row.route)unmatched++
  const profiles=[...groups.values()].sort((a,b)=>a.route.localeCompare(b.route)||a.status-b.status).map(g=>{
    const durations=g.latencies.sort((a,b)=>a-b)
    return {route:g.route,httpStatus:String(g.status),requests:durations.length,p50Ms:quantile(durations,.5),p95Ms:quantile(durations,.95)}
  })
  return {start,end,starts:starts.size,completions:ends.size,requests:paired,errors,unfinished,unmatched,malformed,
    coverage:starts.size?paired/starts.size:null,groups:profiles}
}

/** Preserve the original comparison thresholds. The CPU denominator covers all
 * paired HTTP requests in the same window. Concurrent/background execution is
 * part of measured application CPU and has no inferred per-route allocation. */
export function comparePressure(before,after){
  const result={status:'insufficient',reasons:[],attribution:'application_cpu_per_observed_http_request'}
  for(const window of [before,after]){
    const {capacity,traffic}=window
    if(capacity.start!==traffic.start||capacity.end!==traffic.end||capacity.end-capacity.start!==fiveMinutes)
      fail('pressure_window_mismatch')
    if(capacity.status!=='observed')result.reasons.push('provider_capacity_incomplete')
    if(traffic.coverage!==1||traffic.unmatched||traffic.malformed)result.reasons.push('request_coverage_incomplete')
    if(traffic.requests<POLICY.minimumInvocations)result.reasons.push('sample_below_minimum')
  }
  if(before.capacity.end>after.capacity.start)fail('pressure_window_overlap')
  if(result.reasons.length)return {...result,reasons:[...new Set(result.reasons)]}
  const a=before.traffic,b=after.traffic
  if((BigInt(b.errors)*BigInt(a.requests)-BigInt(a.errors)*BigInt(b.requests))*100n >
    BigInt(Math.round(POLICY.errorRateDelta*100))*BigInt(a.requests)*BigInt(b.requests))
    return {...result,status:'regression',reasons:['server_error_rate_increased']}
  const ratio=b.requests/a.requests,byPair=new Map(a.groups.map(g=>[JSON.stringify([g.route,g.httpStatus]),g]))
  if(ratio>POLICY.maximumTrafficRatio||ratio<1/POLICY.maximumTrafficRatio)return {...result,status:'not_comparable',reasons:['traffic_volume_changed']}
  if(byPair.size!==b.groups.length||b.groups.some(g=>!byPair.has(JSON.stringify([g.route,g.httpStatus]))))
    return {...result,status:'not_comparable',reasons:['route_or_status_groups_changed']}
  for(const current of b.groups){
    const previous=byPair.get(JSON.stringify([current.route,current.httpStatus]))
    if(Math.abs(previous.requests/a.requests-current.requests/b.requests)>POLICY.maximumRouteShareDelta)
      return {...result,status:'not_comparable',reasons:['traffic_mix_changed']}
    if(current.requests<POLICY.minimumInvocations||previous.requests<POLICY.minimumInvocations)result.reasons.push('group_sample_below_minimum')
  }
  if(result.reasons.length)return {...result,reasons:[...new Set(result.reasons)]}
  const prior=before.capacity.cpuMs/a.requests,current=after.capacity.cpuMs/b.requests
  const regression=current>prior*POLICY.cpuRatio&&current-prior>POLICY.cpuDeltaMs
  return {...result,status:regression?'regression':'pass',reasons:regression?['application_cpu_per_observed_request_increased']:[],beforeMs:prior,afterMs:current}
}

/** The provider log stream can omit starts. Its distinct IDs give an observed
 * total across devices, without certifying an upper bound for any device. */
export function legacyFilesystemBudget(events,start,end) {
  if(end-start!==fiveMinutes||start%fiveMinutes!==0) fail('filesystem_window_invalid')
  const seen=new Set()
  let traffic=false, malformed=false
  for(const event of events){
    const value=JSON.parse(event.message)
    if(value.msg!=='api_request_started')continue
    const at=Date.parse(value.timestamp)
    if(dateMatch(at,start,end))traffic=true
    if(value.route!=='/v1/devices/[deviceId]/fs/requests')continue
    if(!Number.isFinite(at)){malformed=true;continue}
    if(!dateMatch(at,start,end))continue
    if(typeof value.invocationId!=='string'||!value.invocationId){malformed=true;continue}
    seen.add(value.invocationId)
  }
  const observed={requests:seen.size,singleDeviceUpperBound:null,threshold:18}
  if(seen.size>18)return {...observed,status:'investigate',reason:'combined_observed_count_above_threshold'}
  const reason=malformed?'filesystem_coverage_unknown':traffic?'origin_completeness_unverified':'no_observed_requests'
  return {...observed,status:'insufficient',reason}
}

/** The configured three-sigma tests compare complete, nonoverlapping quarters
 * for one qualified API application. Missing scheduled observations are visible
 * separately from a recovered signal. No invoice or per-handler CPU is implied. */
export function pressureAnomalies(current,history){
  const quarter=3*fiveMinutes
  const validScope=w=>w.capacity.start===w.traffic.start&&w.capacity.end===w.traffic.end&&
    w.capacity.start%quarter===0&&w.capacity.end-w.capacity.start===quarter
  const trafficAvailable=w=>w.traffic.coverage!==null&&w.traffic.coverage>=.99&&
    !w.traffic.malformed&&w.traffic.starts>0&&w.traffic.unmatched<=.01*w.traffic.starts
  const result={status:'insufficient',firing:[],assessed:[],reasons:[],baselineQuarters:history.length}
  if(!validScope(current))return {...result,reasons:['current_quarter_incomplete']}
  if(history.length<8||history.length>96)return {...result,reasons:['baseline_sample_count']}
  const past=[...history].sort((a,b)=>a.capacity.start-b.capacity.start)
  if(past.some((r,i)=>!validScope(r)||r.capacity.application!==current.capacity.application||
    r.capacity.end>current.capacity.start||(i>0&&r.capacity.start!==past[i-1].capacity.end))||
    past.at(-1).capacity.end!==current.capacity.start)return {...result,reasons:['baseline_scope_or_gap']}
  const provider=[...past,current].every(w=>w.capacity.status==='observed')
  const requests=[...past,current].every(trafficAvailable)
  const measures={requests:[requests,w=>w.traffic.starts],cpuMs:[provider,w=>w.capacity.cpuMs],
    cpuMsPerObservedRequest:[provider&&requests,w=>w.capacity.cpuMs/w.traffic.starts]}
  const values={}
  for(const [name,[available,get]]of Object.entries(measures)){
    if(!available){result.reasons.push(name+'_coverage_incomplete');continue}
    const samples=past.map(get),mean=samples.reduce((a,b)=>a+b,0)/samples.length
    const sigma=Math.sqrt(samples.reduce((a,b)=>a+(b-mean)**2,0)/(samples.length-1))
    const value=get(current),high=mean+3*sigma
    values[name]={value,baselineMean:mean,baselineStandardDeviation:sigma,upper:high}
    result.assessed.push(name)
    if(value>high&&(name==='requests'||current.capacity.cpuMs>10_000))result.firing.push(name)
  }
  return {...result,status:result.firing.length?'firing':result.assessed.length===3?'within_baseline':'insufficient',values}
}

/** Missing coverage must never resolve yesterday's alert. The original
 * notifier still owns delivery, retry, deduplication and recovery state. */
export async function deliverPressure(result,{state={},sink,now,notify}){
  const ids={requests:'cloudflare-api-request-volume',cpuMs:'cloudflare-api-cpu',
    cpuMsPerObservedRequest:'cloudflare-api-cpu-per-observed-request'}
  const selected=Object.fromEntries(result.assessed.map(key=>{
    if(!Object.hasOwn(ids,key))fail('capacity_signal_invalid')
    return [ids[key],state[ids[key]]??{}]
  }))
  const alerts=result.firing.map(key=>{
    if(!result.assessed.includes(key)||!number(result.values[key]?.value))fail('capacity_signal_invalid')
    return {id:ids[key],value:result.values[key].value,owner:'repository-maintainers',runbook:'docs/operations/observability.md',
      action:'Check the version-bound Cloudflare instance CPU and memory, route mix, status and latency; inspect recent deploys and background work.'}
  })
  const delivery=await notify(alerts,{state:selected,sink,now})
  return {...delivery,state:{...state,...delivery.state}}
}
