import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, openSync, closeSync, constants } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { measureReplayEvidence, sanitizeReplayReport, writeSanitizedReport } from './run-proactive-acceptance.mjs'
import { verifyProductionRelease } from './production-release-pin.mjs'

const ORIGIN='https://app.aspectlylabs.com'
const OWNER='cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3'
const WORKSPACE='0f877068-66a0-4893-8801-9a14eb3116b3'
const GROUP='f197747b-64af-42c3-9ac4-8ff335610324'
const COMPARISON='group-decision-comparison-v2'
const EMAIL='alexjiang20232024+mikka-smoke-owner@gmail.com'
const safeError=error=>error instanceof Error && /^(?:preflight|replay)_[a-z0-9_]{1,100}$/.test(error.message)?error.message:'preflight_failed'
const check=(condition,reason)=>{if(!condition)throw Error(reason)}

async function sourceDependencies(repo){
  const module=path=>import(pathToFileURL(resolve(repo,path)).href)
  const driver=resolve(fileURLToPath(new URL('../..',import.meta.url)))
  // Only the transport driver differs from the fixed production checkout.
  // Every shared dataset/policy/receipt/scoring module must remain byte-identical.
  const contractPaths=['tests/fixtures/group-decision-cases.json','lib/coordinator/group-decision-replay.ts',
    'lib/coordinator/group-decision-policy.ts','lib/coordinator/group-decision-chain.ts','lib/coordinator/group-decision-trace.ts','lib/coordinator/decision.ts',
    'lib/coordinator/group-judgment.ts','lib/coordinator/group-correction.ts','lib/coordinator/group-routing.ts','lib/deployment-switches.ts']
  const contractDigests=Object.fromEntries(contractPaths.map(path=>{
    const source=readFileSync(resolve(repo,path)),local=readFileSync(resolve(driver,path))
    check(source.equals(local),'preflight_driver_contract_mismatch')
    return[path,createHash('sha256').update(source).digest('hex')]
  }))
  const [replay,cases,policy]=await Promise.all([import(new URL('../group-decision-replay.ts',import.meta.url)),module('lib/coordinator/group-decision-replay.ts'),module('lib/coordinator/group-decision-policy.ts')])
  return {runReplay:replay.runGroupDecisionReplay,livePolicy:policy.GROUP_LIVE_POLICY_VERSION,contractDigests,
    replayDriverDigest:createHash('sha256').update(readFileSync(resolve(driver,'scripts/group-decision-replay.ts'))).digest('hex'),
    contract:{caseIds:cases.GROUP_REPLAY_CASE_IDS,datasetDigest:cases.GROUP_REPLAY_DATASET_DIGEST,
      comparisonVersion:cases.GROUP_REPLAY_COMPARISON_VERSION,baselinePolicy:policy.GROUP_BASELINE_VERSION,candidatePolicy:policy.GROUP_POLICY_VERSION}}
}

/** One normal owner session; fixed synthetic replay only. No group message,
 * task, Bot, key, policy flag, provider control, or projected action is written. */
export async function runPolicyPreflight({env=process.env,repo=process.cwd(),fetchImpl=fetch,now=Date.now,dependencies,
  verifySource=()=>{check(!execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:repo,encoding:'utf8'}).trim(),'preflight_dirty_source');return execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim()}}={}){
  const revision=env.GROUP_REPLAY_REVISION,deployment=env.GROUP_REPLAY_DEPLOYMENT
  check(/^[a-f0-9]{40}$/.test(revision??'') && /^dpl_[A-Za-z0-9]+$/.test(deployment??''),'preflight_fixed_release_required')
  check(!env.GROUP_REPLAY_ORIGIN || env.GROUP_REPLAY_ORIGIN===ORIGIN,'preflight_origin_rejected')
  check(verifySource()===revision,'preflight_source_mismatch')
  const api=dependencies??await sourceDependencies(repo),contract=api.contract
  check(api.livePolicy==='group-contribution-v1' && contract?.candidatePolicy==='group-contribution-v3'
    && contract.baselinePolicy==='group-route-v0' && contract.comparisonVersion===COMPARISON
    && Array.isArray(contract.caseIds) && contract.caseIds.length===12 && new Set(contract.caseIds).size===12,'preflight_policy_contract')
  const email=env.SMOKE_OWNER_EMAIL,password=env.SMOKE_OWNER_PASSWORD
  check(email?.toLowerCase()===EMAIL && typeof password==='string' && password.length>=8,'preflight_normal_account_required')
  const start=now(),deadline=start+8*60_000,report={schemaVersion:1,kind:'candidate-replay-before-live-promotion',status:'failed',
    sourceRevision:revision,deploymentId:deployment,replayDriverDigest:api.replayDriverDigest??null,contractDigests:api.contractDigests??null,releasePins:{before:null,after:null},livePolicy:'group-contribution-v1',candidatePolicy:contract.candidatePolicy,
    ownerId:OWNER,workspaceId:WORKSPACE,conversationId:GROUP,startedAt:new Date().toISOString(),finishedAt:null,
    session:{loginAttempted:false,loginStatus:null,identityConfirmed:false,logoutAttempted:false,logoutStatus:null,logoutAcknowledged:false},
    scopeConfirmed:false,replay:null,accounting:null,modelScope:{expectedDecisionModel:'openai/gpt-6-luna-decisions',observedDecisionModels:[],workerModel:null,workerExecutionPerformed:false},error:null,policyChanged:false,executionPerformed:false,productionAccepted:false}
  let cookie=''
  const allowed=new Set(['/mikka/api/version','/mikka/api/auth/sign-in/email','/mikka/api/auth/get-session','/mikka/api/auth/sign-out',
    '/mikka/api/conversations', '/mikka/api/conversations/'+GROUP+'/members','/mikka/api/conversations/'+GROUP+'/decisions/replay'])
  const transport=async(url,init={},cleanup=false)=>{
    const parsed=new URL(url),method=init.method??'GET'
    check(parsed.origin===ORIGIN && !parsed.search && allowed.has(parsed.pathname),'preflight_request_scope')
    check((method==='GET' && !['/mikka/api/auth/sign-in/email','/mikka/api/auth/sign-out','/mikka/api/conversations/'+GROUP+'/decisions/replay'].includes(parsed.pathname))
      || (method==='POST' && ['/mikka/api/auth/sign-in/email','/mikka/api/auth/sign-out','/mikka/api/conversations/'+GROUP+'/decisions/replay'].includes(parsed.pathname)),'preflight_method_scope')
    const remaining=cleanup?15000:deadline-now()
    check(remaining>0,'preflight_deadline')
    const signal=AbortSignal.timeout(Math.max(1,Math.min(remaining,30000)))
    return fetchImpl(url,{...init,redirect:'error',signal:init.signal?AbortSignal.any([init.signal,signal]):signal})
  }
  const request=async(path,body,cleanup=false)=>{
    const response=await transport(ORIGIN+'/mikka'+path,{method:body===undefined?'GET':'POST',
      headers:{origin:ORIGIN,'cache-control':'no-store',...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})},cleanup)
    return {response,data:await response.json().catch(()=>null)}
  }
  const version=async()=>{const {response,data}=await request('/api/version');check(response.status===200 && data?.build===revision,'preflight_deployment_changed')}
  try{
    report.releasePins.before=await verifyProductionRelease({revision,deploymentId:deployment,env,fetchImpl,now})
    await version()
    report.session.loginAttempted=true
    const login=await request('/api/auth/sign-in/email',{email,password})
    report.session.loginStatus=login.response.status
    cookie=login.response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ')
    check(login.response.status===200 && cookie,'preflight_login_unconfirmed')
    const session=await request('/api/auth/get-session')
    check(session.response.status===200 && session.data?.user?.id===OWNER && session.data.user.email?.toLowerCase()===EMAIL
      && session.data.session?.userId===OWNER,'preflight_owner_mismatch')
    report.session.identityConfirmed=true
    const groups=await request('/api/conversations')
    const group=groups.data?.conversations?.find(row=>row.id===GROUP)
    check(groups.response.status===200 && group?.kind==='group' && group.workspaceId===WORKSPACE && group.createdBy===OWNER,'preflight_group_scope')
    const members=await request('/api/conversations/'+GROUP+'/members')
    check(members.response.status===200 && Array.isArray(members.data?.members)
      && members.data.members.some(member=>member.memberType==='user' && member.id===OWNER && member.leftAt==null),'preflight_member_scope')
    report.scopeConfirmed=true
    await version()
    const replay=await api.runReplay({env:{GROUP_REPLAY_ORIGIN:ORIGIN,GROUP_REPLAY_CONVERSATION:GROUP,GROUP_REPLAY_DEPLOYMENT:deployment,
      GROUP_REPLAY_REVISION:revision,GROUP_REPLAY_COOKIE:cookie},fetchImpl:transport})
    report.replay=sanitizeReplayReport(replay)
    report.accounting=measureReplayEvidence(replay,contract)
    report.modelScope.observedDecisionModels=[...new Set([...report.replay.baseline,...report.replay.candidate].flatMap(row=>(row.decisions??[]).flatMap(step=>step.receipt?[step.receipt.modelId]:[])))]
    await version()
    check(report.accounting.qualityAccepted===true && report.replay.status==='comparison_ready','preflight_candidate_rejected')
  }catch(error){report.error=safeError(error)}
  finally{
    if(report.releasePins.before){
      try{report.releasePins.after=await verifyProductionRelease({revision,deploymentId:deployment,env,fetchImpl,now})}
      catch(error){report.error??=safeError(error)}
    }
    if(cookie){
      report.session.logoutAttempted=true
      try{const logout=await request('/api/auth/sign-out',{},true);report.session.logoutStatus=logout.response.status;report.session.logoutAcknowledged=logout.response.status===200}catch{report.session.logoutAcknowledged=false}
    }
    cookie=''
    report.finishedAt=new Date().toISOString()
  }
  report.status=!report.error && report.scopeConfirmed && report.releasePins.before && report.releasePins.after && report.accounting?.qualityAccepted===true
    && report.session.logoutAcknowledged?'passed':'failed'
  return report
}

async function main(){
  check(process.env.GITHUB_ACTIONS==='true' && process.env.GITHUB_RUN_ATTEMPT==='1','preflight_manual_rerun_rejected')
  const output=resolve(process.env.GROUP_POLICY_PREFLIGHT_OUTPUT??'group-policy-preflight-sanitized/results.json')
  mkdirSync(resolve(output,'..'),{recursive:true,mode:0o700})
  const lock=openSync(output+'.once',constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);closeSync(lock)
  let report
  try{report=await runPolicyPreflight()}catch(error){report={schemaVersion:1,status:'failed',error:safeError(error),policyChanged:false,executionPerformed:false,productionAccepted:false}}
  report.runnerDigest=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  writeSanitizedReport(report,output)
  console.log(JSON.stringify({status:report.status,livePolicy:report.livePolicy,logicalReplays:report.accounting?.logicalReplays??0,
    completed:report.accounting?.completedLogicalReplays??0,baselineAbstentions:report.accounting?.baselineAbstentions??0,
    candidateCompleted:report.accounting?.candidateCompleted??0,qualityAccepted:report.accounting?.qualityAccepted===true,
    logoutAcknowledged:report.session?.logoutAcknowledged===true,error:report.error??null}))
  if(report.status!=='passed')process.exitCode=1
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(error=>{console.error(safeError(error));process.exitCode=1})
