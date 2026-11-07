import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

export const VERSION = 'batch1615-numeric-attribution-v2'
export const PRODUCER = '0d379dd92fd2d7b3f2b307030c3bcd8234426d0e'
const SHA = /^[0-9a-f]{40}$/, HASH = /^[0-9a-f]{64}$/
const RUN = /^wrun_[A-Za-z0-9_-]{1,160}$/
const STREAM = /^(wrun_[A-Za-z0-9_-]{1,160}):([0-9]{1,6})$/
const KINDS = ['haiku', 'luna']
const MESSAGES = ['model_call_timing', 'turn_timing', 'coordinator_stream_projection_timing']
const METHODS = ['status','oauthStart','oauthResume','oauthComplete','oauthPoll','oauthHandoff','refresh','recover','disconnect','nativeAuth','nativeContext','prepare','quota','usage','models','cleanup','execute','executeStream','nativeStream','acquire','unobserved']
const GO_MS = ['configToServeMs','dbInitMs','rpcBodyMs','authorizeMs','prepareRecordMs','migrationMs','readyAuthMs','refreshMs','cleanupMs','statusMs','readMs','createMs','deleteMs','conversionMs','executorOpenMs','httpHeadersMs','httpFirstEventMs','httpFirstTextEventMs','firstConvertedChunkMs','firstChunkGuardMs','firstEmitMs']
const GO_COUNTS = ['migrationCalls','refreshCalls','readCalls','createCalls','deleteCalls']
const PARENT_MS = ['startedMs','settledMs','spawnToConfigWriteMs','identityMs','identityLoginMs','parentAccessAuthorityMs','parentProjectionReadMs']
const PARENT_COUNTS = ['ordinal','identityLoginCalls','parentAccessAuthorityCalls','parentProjectionReadCalls']
const CLIENT_MS = ['chatObservedMs','committedMs','firstTextMs','headersToFirstTextMs','sendAcknowledgedMs','sendToIdleMs','stopRequestedMs','streamClosedMs','streamHeadersMs','streamRequestedMs','streamStartedMs','postStopChatMs','stopAcknowledgedMs','stopToObservedIdleMs','stopToStreamClosedMs']
const own = (o,k) => o !== null && typeof o === 'object' && Object.hasOwn(o,k)
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const demand = (ok, code) => { if (!ok) throw new Error(code) }
export const sha256 = text => createHash('sha256').update(text).digest('hex')
function cell(o,k,kind='ms') {
  if (!own(o,k)) return { state:'missing' }
  const v = o[k]
  if (v === null) return { state:'null' }
  const valid = kind === 'bool' ? typeof v === 'boolean' : typeof v === 'number' && Number.isFinite(v) && v >= 0 && ((kind === 'count' || kind === 'stageCount') ? Number.isSafeInteger(v) && (kind !== 'stageCount' || v <= 1000000) : v <= 3600000)
  return valid ? { state:kind === 'bool' ? 'boolean' : 'number', value:v } : { state:'invalid' }
}
const cells = (o, keys, kind) => Object.fromEntries(keys.map(k => [k,cell(o,k,kind)]))
const enumCell = (o,k,values) => !own(o,k) ? {state:'missing'} : o[k] === null ? {state:'null'} : values.includes(o[k]) ? {state:'value',value:o[k]} : {state:'invalid'}
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_:.-]{1,240}$/.test(value) ? value : null
function verified(entry) {
  demand(typeof entry?.text === 'string' && Buffer.byteLength(entry.text) <= 16*1024*1024, 'artifact_size_or_type')
  demand(HASH.test(entry.sha256 ?? '') && sha256(entry.text) === entry.sha256, 'artifact_sha_mismatch')
  return entry.text
}
function rawCache(o) {
  return Object.fromEntries(['read','write','creation'].map(k => {
    const v=o?.[k], s=v?.state
    if (!own(o,k)) return [k,{state:'missing'}]
    if (!['missing','null','number','invalid'].includes(s)) return [k,{state:'invalid'}]
    if (s === 'number') { const c=cell(v,'tokens','count'); return [k,c.state==='number'?{state:'number',tokens:c.value}:{state:'invalid'}] }
    return [k,{state:s}]
  }))
}
function stages(s) {
  if (s === undefined) return {state:'missing'}
  if (s === null) return {state:'null'}
  if (!object(s) || s.version !== 1 || !Array.isArray(s.workers)) return {state:'invalid'}
  return {
    state:s.workers.length>16?'invalid':'reported', version:1,
    ...cells(s,['streamEntryMs','firstIpcChunkMs','firstSdkTextMs']),
    overflow:cell(s,'overflow','stageCount'), suppliedWorkers:s.workers.length,
    workers:s.workers.slice(0,16).map(w => {
      const g=w?.go
      return { ...cells(w,PARENT_MS), ...cells(w,PARENT_COUNTS,'stageCount'),
        method:enumCell(w,'method',METHODS),
        outcome:enumCell(w,'outcome',['pending','result','error','cancelled']),
        identityMode:enumCell(w,'identityMode',['static','custody_token','access_token','parent_snapshot','unobserved']),
        goState:enumCell(w,'goState',['reported','missing','invalid']),
        go:g===undefined?{state:'missing'}:g===null?{state:'null'}:!object(g)||g.version!==1?{state:'invalid'}:{
          state:'reported',version:1,...cells(g,GO_MS),...cells(g,GO_COUNTS,'stageCount'),
          accessReadBackend:enumCell(g,'accessReadBackend',['vault','snapshot','unobserved'])
        } }
    })
  }
}
function recordProjection(r) {
  return {streamId:r.streamId,
    ...cells(r,['firstRawTextMs','firstEmittedTextMs','committedMs']),
    ...cells(r,['fingerprintCount','maxHoldback'],'count'),
    ...Object.fromEntries(['firstEmittedAtCommitted','firstBlockedByHoldback','quietEligible','stopped'].map(k=>[k,enumCell(r,k,[0,1])])),
    terminal:enumCell(r,'terminal',[0,1,2,3,4])}
}
function promptPrefix(p) {
  if (p === undefined) return {state:'missing'}
  if (p === null) return {state:'null'}
  if (!object(p)) return {state:'invalid'}
  const hash = (o,k) => !own(o,k)?{state:'missing'}:o[k]===null?{state:'null'}:
    typeof o[k]==='string' && /^[0-9a-f]{12}$/.test(o[k])?{state:'value',value:o[k]}:{state:'invalid'}
  const system=!own(p,'system')?{state:'missing'}:p.system===null?{state:'null'}:
    !Array.isArray(p.system)?{state:'invalid'}:{state:'array',values:p.system.map((_,i)=>hash(p.system,i))}
  return {state:'reported',tools:hash(p,'tools'),system}
}
function recordModel(r) {
  return {workflowRunId:r.workflowRunId,stepId:safeId(r.stepId),attempt:cell(r,'attempt','count'),
    route:enumCell(r,'route',['hosted','subscription']),
    model:enumCell(r,'model',['claude-haiku-5-5','gpt-6-luna']),
    finishReason:enumCell(r,'finishReason',['stop','length','content-filter','tool-calls','error','other','unknown']),
    prefix:promptPrefix(r.prefix),
    ...cells(r,['setupMs','firstTokenMs','firstTextMs','durationMs']),
    ...cells(r,['tools','inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','toolCalls'],'count'),
    interrupted:cell(r,'interrupted','bool'),codexLayoutApplied:cell(r,'codexLayoutApplied','bool'),
    rawCache:rawCache(r.rawCache),subscriptionStages:stages(r.subscriptionStages)}
}
function recordTurn(r) {
  return {workflowRunId:r.workflowRunId,round:cell(r,'round','count'),untilStoredMs:cell(r,'untilStoredMs'),
    modelCalls:cell(r,'modelCalls','count'),
    workflowEventPhase:cells(r.phaseMs,['settings','inbox','begin','prepare','agentPreparation']),
    contextBodyNode:cells(r.phaseMs,['execution','personal','github']),
    preparationBodyNode:cells(r.preparationBodyMs,['begin','prepare'])}
}
// Only explicit JSON objects/JSONL or complete JSON fences are decoded. Unknown
// Markdown layouts remain unsupported. No regex pulls JSON out of free text.
export function extractRecords(text) {
  const records=[]
  let unsupported=0
  function walk(x, meta={}, depth=0) {
    if (depth>12) { unsupported++; return }
    if (typeof x === 'string') {
      const t=x.trim()
      if (!t) return
      try { walk(JSON.parse(t),meta,depth+1); return } catch {}
      let candidates=0, fence=null
      for (const line of t.split(/\r?\n/)) {
        const trimmed=line.trim()
        if (fence !== null) {
          if (/^\x60\x60\x60\s*$/.test(trimmed)) {
            const body=fence.join('\n').trim()
            if (body) walk(body,meta,depth+1); else unsupported++
            fence=null
          } else fence.push(line)
          continue
        }
        if (/^\x60\x60\x60(?:json|jsonl)?\s*$/.test(trimmed)) { candidates++; fence=[]; continue }
        if (!/^[{\[]/.test(trimmed)) continue
        candidates++
        try { walk(JSON.parse(trimmed),meta,depth+1) } catch { unsupported++ }
      }
      if (fence !== null) {
        unsupported++ // An unclosed explicit fence cannot establish complete evidence.
        const body=fence.join('\n').trim()
        if (body) walk(body,meta,depth+1)
      }
      if (!candidates) unsupported++
      return
    }
    if (Array.isArray(x)) { for (const v of x) walk(v,meta,depth+1); return }
    if (!object(x)) return
    const next={requestId:safeId(x.requestId) ?? meta.requestId ?? null}
    if (MESSAGES.includes(x.msg)) { records.push({event:x,...next}); return }
    if (x.structuredContent != null) { walk(x.structuredContent,next,depth+1); return }
    for (const k of ['content','result','logs','entries','items','data','message','text','records']) {
      if (own(x,k)) walk(x[k],next,depth+1)
    }
  }
  walk(text)
  // Do not deduplicate: repeated records can be real retries or HTTP projections.
  return {records,unsupported}
}
function versionFence(w,expectedSha) {
  const inspect = v => !object(v)?'missing':v.matches===true && v.build===expectedSha?'matched':v.build && v.build!==expectedSha?'mismatched':'unconfirmed'
  return {before:inspect(w?.before),after:inspect(w?.after)}
}
function receipts(entries,phase,expectedSha) {
  demand(Array.isArray(entries) && entries.length<=2,'receipt_count')
  const out=new Map()
  for (const e of entries) {
    demand(KINDS.includes(e.kind) && !out.has(e.kind),'duplicate_or_unknown_receipt_kind')
    let w; try {w=JSON.parse(verified(e))} catch(error) {throw new Error(error.message==='artifact_sha_mismatch'?'artifact_sha_mismatch':'receipt_json_invalid')}
    demand(w.applicationSha===expectedSha && w.fixtureKey===e.kind && w.phase==='alex-continuation' && w.case===phase,'receipt_source_scope')
    demand(w.observation==null || w.observation.applicationSha==null || w.observation.applicationSha===expectedSha,'observation_source_scope')
    const fence=versionFence(w,expectedSha)
    out.set(e.kind,{wrapper:w,observation:w.observation,sha256:e.sha256,fence})
  }
  return out
}
function slot(kind,index,p,stop=false) {
  const o=p?.observation
  let r=stop?o:o?.turns?.find(x=>x.index===index)
  const rStatus=enumCell(r,'status',['observed','failed'])
  const wStatus=enumCell(p?.wrapper,'status',['observed','failed'])
  const rawRun=r?.workflowRunId
  demand(rawRun==null || RUN.test(rawRun),'receipt_run_id_invalid')
  const streamId=r?.streamId
  demand(streamId==null || STREAM.test(streamId) && STREAM.exec(streamId)[1]===rawRun,'receipt_stream_scope')
  return {slot:stop?'stop-'+kind:kind+'-'+index,kind,turn:stop?null:index,
    receiptState:p?'present':'missing',receiptSha256:p?.sha256??null,
    wrapperStatus:wStatus,status:rStatus,wrapperAttempted:cell(p?.wrapper,'attempted','bool'),
    wrapperMessageSendAttempts:cell(p?.observation,'messageSendAttempts','count'),versionFence:p?.fence??{before:'missing',after:'missing'},
    workflowRunId:rawRun??null,streamId:streamId??null,
    sent:cell(r,'messageSendAttempted','bool'),messageSendAttempts:cell(r,'messageSendAttempts','count'),
    durationMs:cell(r,'durationMs'),replyCharacters:cell(r,'replyCharacters','count'),
    metrics:cells(r?.metrics,CLIENT_MS),
    failurePresent:!!r?.error || r?.status==='failed' || p?.wrapper?.status==='failed',
    ...(stop?{stopRequested:cell(r?.stop,'requested','bool'),stopAcknowledged:cell(r?.stop,'acknowledged','bool'),
      textConsistency:{matches:cell(r?.textConsistency,'matches','bool'),...cells(r?.textConsistency,['liveCharacters','persistedCharacters'],'count')}}:{}),
    runtime:null}
}
export function aggregate(input) {
  demand(input?.schemaVersion===1 && SHA.test(input.expectedSha??'') && /^dpl_[A-Za-z0-9]+$/.test(input.deploymentId??''),'manifest_source_invalid')
  demand(input.producerSourceCommit===PRODUCER,'unsupported_producer_source')
  demand(['cache','cache-live'].includes(input.phase),'unsupported_phase')
  const cache=receipts(input.cacheReceipts??[],input.phase,input.expectedSha)
  const stops=receipts(input.stopReceipts??[],'ordinary-stop',input.expectedSha)
  const stopKinds=input.stopKinds??[]
  demand(Array.isArray(stopKinds) && stopKinds.length<=2 && new Set(stopKinds).size===stopKinds.length && stopKinds.every(k=>KINDS.includes(k)),'stop_plan_invalid')
  demand([...stops.keys()].every(k=>stopKinds.includes(k)),'unplanned_stop_receipt')
  for (const p of cache.values()) {
    const rows=p.observation?.turns??[]
    demand(Array.isArray(rows) && rows.length<=3 && rows.every(r=>[1,2,3].includes(r.index)) && new Set(rows.map(r=>r.index)).size===rows.length,'cache_turns_invalid')
  }
  const slots=KINDS.flatMap(k=>[1,2,3].map(i=>slot(k,i,cache.get(k))))
  const stopSlots=stopKinds.map(k=>slot(k,null,stops.get(k),true))
  const byRun=new Map()
  for(const s of [...slots,...stopSlots]) if(s.workflowRunId) {
    demand(!byRun.has(s.workflowRunId),'ambiguous_run_across_slots'); byRun.set(s.workflowRunId,s)
  }
  const caps=input.captures??[]
  demand(Array.isArray(caps)&&caps.length<=8,'capture_budget_exceeded')
  const captured=new Set(), captureProof=[]
  for(const c of caps) {
    demand(RUN.test(c.workflowRunId??'')&&!captured.has(c.workflowRunId),'duplicate_or_invalid_capture_run')
    demand(byRun.has(c.workflowRunId),'unbound_capture_run')
    demand(c.applicationSha===input.expectedSha && c.deploymentId===input.deploymentId,'capture_source_scope')
    demand(typeof c.since==='string' && typeof c.until==='string' && Number.isFinite(Date.parse(c.since)) && Date.parse(c.until)>=Date.parse(c.since),'capture_time_range')
    demand(typeof c.complete==='boolean','capture_completeness_required')
    captured.add(c.workflowRunId)
    const raw=verified(c), parsed=extractRecords(raw)
    const events={model:[],turn:[],projection:[]}, signatures=new Map()
    for(const {event:r,requestId} of parsed.records) {
      const run=r.msg==='coordinator_stream_projection_timing'?STREAM.exec(r.streamId??'')?.[1]:r.workflowRunId
      demand(run===c.workflowRunId,'record_run_scope_mismatch')
      if(own(r,'deploymentId')) demand(r.deploymentId===input.deploymentId,'record_deployment_scope_mismatch')
      const type=r.msg==='model_call_timing'?'model':r.msg==='turn_timing'?'turn':'projection'
      const record=type==='model'?recordModel(r):type==='turn'?recordTurn(r):recordProjection(r)
      const fingerprint=sha256(JSON.stringify({r,requestId}))
      const duplicateOf=signatures.get(fingerprint)??null
      const ordinal=events.model.length+events.turn.length+events.projection.length+1
      if(duplicateOf===null)signatures.set(fingerprint,ordinal)
      events[type].push({ordinal,requestId,duplicateOf,...record})
    }
    byRun.get(c.workflowRunId).runtime={captureSha256:c.sha256,
      complete:c.complete && parsed.unsupported===0 && parsed.records.length>0,
      parseState:parsed.records.length?'recognized':'unsupported_or_empty',
      unsupportedContainers:parsed.unsupported,
      projectionAssociation:events.projection.length===0?'missing':events.projection.length===1&&events.projection[0].requestId?'single_scoped_http':'multiple_or_unidentified_http',
      ...events}
    captureProof.push({workflowRunId:c.workflowRunId,sha256:c.sha256,declaredComplete:c.complete,since:c.since,until:c.until})
  }
  const warm=slots.filter(s=>s.turn>1).map(s=>({slot:s.slot,
    passed:s.sent.value===true && s.status.value==='observed' && s.wrapperStatus.value==='observed' && s.versionFence.before==='matched' && s.versionFence.after==='matched' && s.metrics.firstTextMs.state==='number' && s.metrics.firstTextMs.value<=3000}))
  return {schemaVersion:1,analysisVersion:VERSION,phase:input.phase,
    applicationSha:input.expectedSha,deploymentId:input.deploymentId,producerSourceCommit:PRODUCER,
    clocks:{
      client:'per-send performance.now; sole 3000ms acceptance clock',
      model:'Node requestedAt reset after resolver; firstText is first SDK text-delta event, not an independent nonempty guarantee',
      subscription:'0d collector constructed before prefix/layout/identity/resolve; context attached only after resolve; resolver children unobserved',
      goRpc:'per-child RPC entry; firstEmit differs from provider HTTP origin',
      goHttp:'per-child before client.Do; first text requires nonempty provider delta',
      projection:'one HTTP projection instance; raw/emitted/commit relative to its own start',
      workflow:'event timestamps; context/preparation bodies are separate Node wall durations',
      arithmetic:'no cross-clock subtraction or sum; missing values are never zero'
    },
    fixedCacheSlots:6,cache:slots,ordinaryStop:stopSlots,captures:captureProof,
    warmAcceptance:{denominator:4,thresholdMs:3000,slots:warm,passed:warm.every(x=>x.passed)},
    knownRuns:byRun.size, slotsWithoutRun:[...slots,...stopSlots].filter(s=>!s.workflowRunId).length,
    runtimeCompleteness:byRun.size>0 && [...slots,...stopSlots].every(s=>!s.workflowRunId || s.runtime?.complete===true)
  }
}
export function loadManifest(path) {
  const m=JSON.parse(readFileSync(path,'utf8')), base=dirname(resolve(path))
  for(const key of ['cacheReceipts','stopReceipts','captures']) m[key]=(m[key]??[]).map(e=>({...e,text:readFileSync(resolve(base,e.path),'utf8')}))
  return m
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  demand(process.argv.length===4,'usage_node_aggregate_manifest_output')
  const result=aggregate(loadManifest(process.argv[2]))
  writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n',{mode:0o600})
  console.log(JSON.stringify({analysisVersion:VERSION,cacheSlots:6,stopSlots:result.ordinaryStop.length,captures:result.captures.length,warmPassed:result.warmAcceptance.passed,runtimeComplete:result.runtimeCompleteness}))
}
