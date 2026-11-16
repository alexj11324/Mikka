import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root=resolve(process.argv[2]), path=q=>join(root,'run/case',q)
const json=file=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null
const lines=file=>existsSync(file)?readFileSync(file,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)):[]
const proof=json(path('delivery.json'))??{}
const stages=proof.stages??[]
const digest=v=>createHash('sha256').update(v).digest('hex')
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v)?v:null
const outcomes=stages.map(s=>({stage:String(s.stage).slice(0,150),phase:['execute','review'].includes(s.phase)?s.phase:undefined,outcome:['succeeded','failed','blocked','cancelled'].includes(s.outcome)?s.outcome:undefined,stopReason:typeof s.stopReason==='string'&&/^[a-z_]{1,55}$/.test(s.stopReason)?s.stopReason:undefined,at:s.at,run:uuid(s.runId??s.id),candidate:uuid(s.candidateId),ownerStatus: typeof s.status==='number'?s.status:undefined,code: typeof s.code==='string'&&/^[\w-]{1,100}$/.test(s.code)?s.code:undefined})).filter(s=>s.stage!=='device REST request')
const runtime=stages.find(s=>s.stage==='canonical authorized task detail')
const native=stages.filter(s=>s.stage==='real native MCP report and clean fixed candidate persisted')
const bound=stages.find(s=>s.stage==='two independent lease identities and attested isolated DB/HTTPS origin')
const decisions=lines(path('decisions.jsonl'));const result={
 publicRevision:process.env.PUBLIC_SOURCE,publicTree:process.env.PUBLIC_TREE,harnessRevision:process.env.GITHUB_SHA,
 cli:'official Claude Code 2.1.309',cliSha256:proof.cliSha256,modelId:proof.model,ggufSha256:proof.weightSha256,
 providerKind:'isolated CPU GGUF, no commercial subscription',job:process.env.GITHUB_RUN_ID,success:proof.success===true,
 environment:bound?{leaseId:uuid(bound.leaseId),instanceId:uuid(bound.instanceId),scope:'loopback-only TLS/isolated PG17, two leased identities'}:null,
 progress:outcomes,native:native.map(s=>({stage:s.phase,run:uuid(s.id),session:uuid(s.native),model:s.model,reportSha256:digest(s.actualModelReport),criteriaCount:s.criteria?.length??0})),
 generation:decisions.map(s=>({tokens:s.generatedTokens,mode:s.mode,model:s.model,selectedAction:(()=>{const a=JSON.parse(s.generated).action;return ['answer','submit','search'].includes(a)?a:undefined})(),outputSha256:digest(s.generated)})),
 target:runtime?{state:runtime.task?.status,group:runtime.task?.group,ownerKind:runtime.task?.workOwner?.kind,humanReceipts:runtime.receipts?.length,memberStatus:runtime.memberDenial?.status}:null,
 failure:proof.failure?{kind:/^[\w-]{1,60}$/.test(proof.failure.name||'')?proof.failure.name:'Error',code:/^[\w-]{1,100}$/.test(proof.failure.code||'')?proof.failure.code:undefined,
 position:String(proof.failure.location??'').match(/current-review\.mts:\d+:\d+|work-independent-review\.mts:\d+:\d+/)?.[0]}:null
}
const report=JSON.stringify(result,null,2)+'\n'
if(/mkg_[A-Za-z0-9_-]{35,}|BEGIN [A-Z ]*PRIVATE KEY|postgres(?:ql)?:\/\/|(?:bearer|set-cookie):|(?:session_token|sessionToken)=/i.test(report))throw Error('receipt boundary')
writeFileSync(join(root,'public-receipt.json'),report,{mode:0o600})
