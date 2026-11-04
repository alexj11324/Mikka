import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { GROUP_BASELINE_VERSION, GROUP_POLICY_VERSION } from '../lib/coordinator/group-decision-policy'
import { GROUP_REPLAY_CASE_IDS, GROUP_REPLAY_DATASET, GROUP_REPLAY_DATASET_DIGEST, summarizeGroupDecisionReplay, type GroupDecisionReplay } from '../lib/coordinator/group-decision-replay'
import { GROUP_DECISION_PROTOCOL, GROUP_MAX_ROUTING_DECISIONS } from '../lib/coordinator/group-decision-chain'
import { groupDecisionSteps } from '../lib/coordinator/group-decision-trace'

/** Normal cookie/PAT authentication, fixed production deployment, fixed cases.
 * Evidence contains no input prompts, group history, token or cookies. */
export async function runGroupDecisionReplay({env=process.env,fetchImpl=fetch}:{env?:Record<string,string|undefined>;fetchImpl?:typeof fetch}={}) {
  const origin=env.GROUP_REPLAY_ORIGIN ?? 'https://app.aspectlylabs.com'
  if(origin!=='https://app.aspectlylabs.com')throw Error('replay_origin_rejected')
  const conversationId=env.GROUP_REPLAY_CONVERSATION
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(conversationId ?? ''))throw Error('replay_group_required')
  const deployment=env.GROUP_REPLAY_DEPLOYMENT,revision=env.GROUP_REPLAY_REVISION
  if(!/^dpl_[A-Za-z0-9]+$/.test(deployment ?? '') || !/^[a-f0-9]{40}$/.test(revision ?? ''))throw Error('replay_fixed_deployment_required')
  const token=env.GROUP_REPLAY_TOKEN,cookie=env.GROUP_REPLAY_COOKIE
  if(Boolean(token)===Boolean(cookie) || token && !/^mkp_[A-Za-z0-9_-]{43}$/.test(token))throw Error('replay_normal_auth_required')
  const request=async(path:string,body?:unknown)=>{
    const response=await fetchImpl(`${origin}/mikka${path}`,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{origin,'cache-control':'no-store',...(token?{authorization:`Bearer ${token}`}:{cookie:cookie!}),...(body?{'content-type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})})
    const data:unknown=await response.json().catch(()=>null)
    return {response,data}
  }
  const version=async()=>{
    const {response,data}=await request('/api/version')
    if(!response.ok || (data as {build?:unknown}|null)?.build!==deployment)throw Error('replay_deployment_changed')
  }
  const report={schemaVersion:1,evidenceKind:'actual-decision-inference' as const,dataset:GROUP_REPLAY_DATASET,datasetDigest:GROUP_REPLAY_DATASET_DIGEST,
    deploymentId:deployment,revision,conversationId,startedAt:new Date().toISOString(),finishedAt:'',status:'running',error:null as string|null,
    baseline:[] as GroupDecisionReplay[],candidate:[] as GroupDecisionReplay[],
    scope:'Actual Decision inference: 24 logical case replays, each with its bounded provider-request chain. Execution projected/not performed. Cost covers routing requests only, not correction, contribution, chat, tools or Factory.',
    productionAccepted:false,policyChanged:false}
  try {
    for(const [policyVersion,rows] of [[GROUP_BASELINE_VERSION,report.baseline],[GROUP_POLICY_VERSION,report.candidate]] as const) {
      for(const caseId of GROUP_REPLAY_CASE_IDS) {
        await version()
        const {response,data}=await request(`/api/conversations/${conversationId}/decisions/replay`,{caseId,policyVersion})
        const row=data as GroupDecisionReplay|null
        if(!row || row.schemaVersion!==1 || row.caseId!==caseId || row.policyVersion!==policyVersion || row.datasetDigest!==GROUP_REPLAY_DATASET_DIGEST || row.executionPerformed!==false || row.policyChanged!==false || row.evidenceKind!=='actual-decision-inference')throw Error('replay_unbound_evidence')
        rows.push(row)
        // Do not retry or select another provider after a charged/unknown failure.
        if(!response.ok || row.status!=='complete' || !row.receipt)throw Error('replay_decision_unavailable')
        const chain=groupDecisionSteps(row.decisions)
        if(row.decisionProtocol!==GROUP_DECISION_PROTOCOL || !Array.isArray(row.decisions) || !chain.length || chain.length!==row.decisions.length || chain.length>GROUP_MAX_ROUTING_DECISIONS
          || chain.some((step,index)=>step.index!==index || step.status!=='complete' || !step.receipt)
          || new Set(chain.map(step=>step.receipt!.executionId)).size!==chain.length || new Set(chain.map(step=>step.receipt!.providerGenerationId)).size!==chain.length
          || chain[0].receipt!.executionId!==row.receipt.executionId || chain[0].receipt!.providerGenerationId!==row.receipt.providerGenerationId)throw Error('replay_chain_unbound')
      }
    }
    await version()
    report.status='complete'
  }catch(error){report.status='failed';report.error=error instanceof Error && /^replay_[a-z0-9_]+$/.test(error.message)?error.message:'replay_request_failed'}
  report.finishedAt=new Date().toISOString()
  const baseline=summarizeGroupDecisionReplay(report.baseline),candidate=summarizeGroupDecisionReplay(report.candidate)
  const decisionReviewReady=report.status==='complete' && baseline.coverage===1 && candidate.coverage===1 && candidate.failures.length===0
    && candidate.falseIntervention<=baseline.falseIntervention && candidate.missedIntervention<=baseline.missedIntervention
  return {...report,comparison:{baseline,candidate,decisionReviewReady,requiresHumanReview:true,executionAcceptanceRequired:true}}
}

async function main() {
  const output=process.argv[process.argv.indexOf('--output')+1]
  if(!process.argv.includes('--output') || !output)throw Error('Usage: set GROUP_REPLAY_* environment variables, then --output report.json')
  const report=await runGroupDecisionReplay()
  writeFileSync(output,`${JSON.stringify(report,null,2)}\n`,{mode:0o600})
  console.log(JSON.stringify({output,status:report.status,decisionReviewReady:report.comparison.decisionReviewReady,productionAccepted:false}))
  if(!report.comparison.decisionReviewReady)process.exitCode=1
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) void main().catch(error=>{console.error(error instanceof Error && /^replay_[a-z0-9_]+$/.test(error.message)?error.message:'replay_failed');process.exitCode=1})
