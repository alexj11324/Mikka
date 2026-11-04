import { createHash } from 'node:crypto'
import dataset from '../../tests/fixtures/group-decision-cases.json'
import type { DecisionExecution, invokeDecision } from './decide'
import { createGroupJudgment } from './group-judgment'
import { groupDecisionReceipt } from './group-decision-trace'
import { getGroupDecisionPolicy, type GroupPolicyVersion } from './group-decision-policy'
import { mentionRoute, type GroupMessage, type GroupRoute, type GroupTaskReference, type RoutingMember } from './group-routing'
import type { GroupEvalCase } from './group-decision-eval'

type ReplayCase = GroupEvalCase & { replayMode?: 'runtime-only'; tasks?: GroupTaskReference[] }
export const GROUP_REPLAY_DATASET = dataset.version
/** Hash the same canonical JSON value in the server and the standalone runner. */
export const GROUP_REPLAY_DATASET_DIGEST = createHash('sha256').update(JSON.stringify(dataset)).digest('hex')
const cases = dataset.cases as ReplayCase[]
export const GROUP_REPLAY_CASE_IDS = cases.filter(item=>item.replayMode!=='runtime-only').map(item=>item.id)
export const GROUP_REPLAY_RUNTIME_CASE_IDS = cases.filter(item=>item.replayMode==='runtime-only').map(item=>item.id)

export type GroupDecisionReplay = {
  schemaVersion: 1
  caseId: string
  dataset: string
  datasetDigest: string
  inputDigest: string
  policyVersion: GroupPolicyVersion
  evidenceKind: 'actual-decision-inference'
  status: 'complete' | 'invalid_decision' | 'unavailable'
  receipt: DecisionExecution | null
  route: Pick<GroupRoute, 'by'|'action'|'reason'|'responders'|'delegation'> | null
  decisionLatencyMs: number | null
  decisionCostUsd: number | null
  costScope: 'primary-routing-decision-api'
  executionPerformed: false
  policyChanged: false
  /** These are selected intentions only. No wake, chat, tool, task or publication ran. */
  projection: { intervention: boolean; selectedResponderCount: number; delegationOperation: string | null; reportTiming: string | null } | null
}

/** Only fixed synthetic inputs reach the provider. Curated expected labels are
 * never part of the model input or used to manufacture its observations. */
export async function replayGroupDecision(caseId: string, policyVersion: GroupPolicyVersion, invoke: typeof invokeDecision): Promise<GroupDecisionReplay> {
  const item = cases.find(entry=>entry.id===caseId)
  if (!item || item.replayMode==='runtime-only') throw Error('unsupported_group_replay_case')
  const policy = getGroupDecisionPolicy(policyVersion)
  const message: GroupMessage = { text:item.message, mentions:item.mentions ?? [], recent:item.context ?? [], tasks:item.tasks ?? [] }
  const members = structuredClone(dataset.members) as RoutingMember[]
  const mentioned = mentionRoute(message,members)
  const selected = mentioned ? members.filter(member=>mentioned.responders.includes(member.id)) : members
  const inputDigest = createHash('sha256').update(JSON.stringify({message,members:selected,leadId:null,corrections:[]})).digest('hex')
  const observed:{receipt:DecisionExecution|null}={receipt:null}
  let route: GroupRoute | null = null
  const judgment = createGroupJudgment(async (...args)=>{
    const result = await invoke(...args)
    observed.receipt = groupDecisionReceipt(result?.execution)
    return result
  },policy.version)
  try { route = await judgment.route(message,selected,null,[]) }
  catch { /* Preserve a real invocation receipt even if route validation failed. */ }
  // Missing provider evidence must never become a model-measured route.
  const verified=observed.receipt
  const safeRoute = verified && route ? { by:mentioned?'mention' as const:route.by, action:route.action, reason:route.reason,
    responders:[...route.responders], ...(route.delegation?{delegation:{...route.delegation}}:{}) } : null
  return { schemaVersion:1,caseId,dataset:GROUP_REPLAY_DATASET,datasetDigest:GROUP_REPLAY_DATASET_DIGEST,inputDigest,policyVersion:policy.version,
    evidenceKind:'actual-decision-inference',status:!verified?'unavailable':safeRoute?'complete':'invalid_decision',receipt:verified,route:safeRoute,
    decisionLatencyMs:verified?Date.parse(verified.completedAt)-Date.parse(verified.startedAt):null,
    decisionCostUsd:null,costScope:'primary-routing-decision-api',executionPerformed:false,policyChanged:false,
    projection:safeRoute?{intervention:!['ignore','observe'].includes(safeRoute.action ?? ''),selectedResponderCount:safeRoute.responders.length,
      delegationOperation:safeRoute.delegation?.operation ?? null,reportTiming:safeRoute.delegation?.reportTiming ?? null}:null }
}

/** Decision-only comparison. It deliberately cannot claim execution recall,
 * public-message noise, task completion, or production acceptance. */
export function summarizeGroupDecisionReplay(results: readonly GroupDecisionReplay[]) {
  if (new Set(results.map(row=>row.caseId)).size!==results.length || results.some(row=>!GROUP_REPLAY_CASE_IDS.includes(row.caseId)
    || row.datasetDigest!==GROUP_REPLAY_DATASET_DIGEST || row.evidenceKind!=='actual-decision-inference' || row.executionPerformed!==false)) throw Error('invalid_group_replay_evidence')
  let measured=0,actionCorrect=0,responderCorrect=0,falseIntervention=0,missedIntervention=0,knownCostUsd=0,knownCosts=0
  const latencies:number[]=[],failures:{caseId:string;reason:string}[]=[]
  for (const row of results) {
    const item=cases.find(entry=>entry.id===row.caseId)!
    const receipt=groupDecisionReceipt(row.receipt ?? undefined)
    if (!receipt || row.status!=='complete' || !row.route) {failures.push({caseId:row.caseId,reason:receipt?'invalid_decision':'receipt_missing'});continue}
    measured++
    const actionMatches=item.expected.actions.includes(row.route.action ?? '')
    const roleMatches=item.expected.responders===undefined || (item.expected.responders.length===row.route.responders.length && item.expected.responders.every((id,index)=>id===row.route!.responders[index]))
    if (actionMatches) actionCorrect++;else failures.push({caseId:row.caseId,reason:'action'})
    if (roleMatches) responderCorrect++;else failures.push({caseId:row.caseId,reason:'responder'})
    if (item.expected.reportTiming && item.expected.reportTiming!==row.route.delegation?.reportTiming) failures.push({caseId:row.caseId,reason:'report_timing'})
    const active=!['ignore','observe'].includes(row.route.action ?? '')
    if (active && item.expected.intervene===false) falseIntervention++
    if (!active && item.expected.intervene===true) missedIntervention++
    latencies.push(Date.parse(receipt.completedAt)-Date.parse(receipt.startedAt))
    if (row.decisionCostUsd!==null && Number.isFinite(row.decisionCostUsd) && row.decisionCostUsd>=0) {knownCostUsd+=row.decisionCostUsd;knownCosts++}
  }
  latencies.sort((a,b)=>a-b)
  return { cases:GROUP_REPLAY_CASE_IDS.length,measured,coverage:measured/GROUP_REPLAY_CASE_IDS.length,actionAccuracy:measured?actionCorrect/measured:null,
    responderAccuracy:measured?responderCorrect/measured:null,falseIntervention,missedIntervention,failures,
    decisionLatency:{samples:latencies.length,p50Ms:latencies.length?latencies[Math.floor((latencies.length-1)*0.5)]:null,p95Ms:latencies.length?latencies[Math.ceil((latencies.length-1)*0.95)]:null},
    cost:{knownUsd:knownCostUsd,knownObservations:knownCosts,unknownObservations:results.length-knownCosts},
    runtimeCasesExcluded:[...GROUP_REPLAY_RUNTIME_CASE_IDS],executionMeasured:false as const,productionAccepted:false as const,policyChanged:false as const }
}
