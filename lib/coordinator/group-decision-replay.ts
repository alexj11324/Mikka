import { createHash } from 'node:crypto'
import dataset from '../../tests/fixtures/group-decision-cases.json'
import type { DecisionExecution, invokeDecision } from './decide'
import { createGroupJudgment } from './group-judgment'
import { groupDecisionReceipt, groupDecisionSteps } from './group-decision-trace'
import { GROUP_DECISION_PROTOCOL, groupDecisionTotals, type GroupDecisionFailure, type GroupDecisionStep } from './group-decision-chain'
import { GroupJudgmentPendingError } from './group-correction'
import { getGroupDecisionPolicy, type GroupPolicyVersion } from './group-decision-policy'
import { mentionRoute, type GroupMessage, type GroupRoute, type GroupTaskReference, type RoutingMember } from './group-routing'
import type { GroupEvalCase } from './group-decision-eval'

type ReplayCase = GroupEvalCase & { replayMode?: 'runtime-only'; tasks?: GroupTaskReference[] }
export const GROUP_REPLAY_DATASET = dataset.version
export const GROUP_REPLAY_COMPARISON_VERSION = 'group-decision-comparison-v2' as const
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
  /** First routing receipt above; all conditional requests below. */
  decisionProtocol: typeof GROUP_DECISION_PROTOCOL
  decisions: GroupDecisionStep[]
  failureReason: GroupDecisionFailure | null
  decisionCalls: ReturnType<typeof groupDecisionTotals>['decisionCalls']
  decisionCost: ReturnType<typeof groupDecisionTotals>['decisionCost']
  route: Pick<GroupRoute, 'by'|'action'|'reason'|'responders'|'delegation'> | null
  decisionLatencyMs: number | null
  decisionCostUsd: number | null
  costScope: 'routing-decision-chain'
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
  let route: GroupRoute | null = null
  let decisions: GroupDecisionStep[] = [], failureReason: GroupDecisionFailure | null = null
  const judgment = createGroupJudgment(invoke,policy.version)
  try { route = await judgment.route(message,selected,null,[]); decisions=groupDecisionSteps(route.decisions) }
  catch (error) {
    if (error instanceof GroupJudgmentPendingError) { decisions=groupDecisionSteps(error.decisions); failureReason=error.decisionFailure??'unavailable' }
    else failureReason='unavailable'
  }
  // Missing provider evidence must never become a model-measured route.
  const verified=decisions[0]?.receipt ?? null
  const safeRoute = verified && route ? { by:mentioned?'mention' as const:route.by, action:route.action, reason:route.reason,
    responders:[...route.responders], ...(route.delegation?{delegation:{...route.delegation}}:{}) } : null
  return { schemaVersion:1,caseId,dataset:GROUP_REPLAY_DATASET,datasetDigest:GROUP_REPLAY_DATASET_DIGEST,inputDigest,policyVersion:policy.version,
    evidenceKind:'actual-decision-inference',status:!verified?'unavailable':safeRoute?'complete':'invalid_decision',receipt:verified,route:safeRoute,
    decisionProtocol:GROUP_DECISION_PROTOCOL,decisions,failureReason,...groupDecisionTotals(decisions),
    costScope:'routing-decision-chain',executionPerformed:false,policyChanged:false,
    projection:safeRoute?{intervention:!['ignore','observe'].includes(safeRoute.action ?? ''),selectedResponderCount:safeRoute.responders.length,
      delegationOperation:safeRoute.delegation?.operation ?? null,reportTiming:safeRoute.delegation?.reportTiming ?? null}:null }
}

/** A fully receipted explicit abstention is an observed semantic failure. It
 * never becomes an ignore route, a successful silence or a candidate pass. */
export function groupReplayAbstained(row: GroupDecisionReplay) {
  if (row.status !== 'invalid_decision' || row.failureReason !== 'uncertain' || row.route !== null || row.projection !== null
    || !Array.isArray(row.decisions)) return false
  const primary=groupDecisionReceipt(row.receipt ?? undefined),steps=groupDecisionSteps(row.decisions)
  return Boolean(primary && steps.length>0 && steps.length===row.decisions.length
    && steps.every((step,index)=>step.index===index && step.receipt
      && (index===steps.length-1 ? step.status==='invalid_decision' && step.failure==='uncertain' : step.status==='complete' && step.failure===null))
    && new Set(steps.map(step=>step.receipt?.executionId)).size===steps.length
    && new Set(steps.map(step=>step.receipt?.providerGenerationId)).size===steps.length
    && steps[0].receipt?.executionId===primary.executionId && steps[0].receipt?.providerGenerationId===primary.providerGenerationId
    && steps[0].receipt?.requestDigest===primary.requestDigest)
}

/** Decision-only comparison. It deliberately cannot claim execution recall,
 * public-message noise, task completion, or production acceptance. */
export function summarizeGroupDecisionReplay(results: readonly GroupDecisionReplay[]) {
  if (new Set(results.map(row=>row.caseId)).size!==results.length || results.some(row=>!GROUP_REPLAY_CASE_IDS.includes(row.caseId)
    || row.datasetDigest!==GROUP_REPLAY_DATASET_DIGEST || row.evidenceKind!=='actual-decision-inference' || row.executionPerformed!==false)) throw Error('invalid_group_replay_evidence')
  let measured=0,actionCorrect=0,responderCorrect=0,falseIntervention=0,missedIntervention=0
  let abstentions=0,unresolvedPositive=0,unresolvedNegative=0,intentionalNonIntervention=0
  const latencies:number[]=[],failures:{caseId:string;reason:string}[]=[]
  const allDecisions:GroupDecisionStep[]=[],generations=new Set<string>()
  for (const row of results) {
    const item=cases.find(entry=>entry.id===row.caseId)!
    const receipt=groupDecisionReceipt(row.receipt ?? undefined)
    // Account for genuine paid/unknown attempts BEFORE route validity. Legacy
    // single-call reports remain readable without inventing a sequential chain.
    const decisions=Array.isArray(row.decisions)?groupDecisionSteps(row.decisions):[{id:`legacy-${row.caseId}`,phase:'legacy_primary' as const,index:0,status:row.status,failure:null,receipt,decisionCostUsd:row.decisionCostUsd}]
    for (const step of decisions) {
      const generation=step.receipt?.providerGenerationId
      if (generation && generations.has(generation)) continue
      if (generation) {generations.add(generation);latencies.push(Date.parse(step.receipt!.completedAt)-Date.parse(step.receipt!.startedAt))}
      allDecisions.push(step)
    }
    const completeChain=!Array.isArray(row.decisions) || (decisions.length===row.decisions.length && decisions.length>0
      && decisions.every((step,index)=>step.index===index && step.status==='complete' && step.receipt)
      && new Set(decisions.map(step=>step.receipt?.providerGenerationId)).size===decisions.length
      && new Set(decisions.map(step=>step.receipt?.executionId)).size===decisions.length
      && decisions[0].receipt?.executionId===receipt?.executionId)
    if (!receipt || row.status!=='complete' || !row.route || !completeChain) {
      if (groupReplayAbstained(row)) abstentions++
      if (item.expected.intervene===true) {missedIntervention++;unresolvedPositive++}
      if (item.expected.intervene===false) unresolvedNegative++
      failures.push({caseId:row.caseId,reason:receipt?'invalid_decision':'receipt_missing'})
      continue
    }
    measured++
    const actionMatches=item.expected.actions.includes(row.route.action ?? '')
    const roleMatches=item.expected.responders===undefined || (item.expected.responders.length===row.route.responders.length && item.expected.responders.every((id,index)=>id===row.route!.responders[index]))
    if (actionMatches) actionCorrect++;else failures.push({caseId:row.caseId,reason:'action'})
    if (roleMatches) responderCorrect++;else failures.push({caseId:row.caseId,reason:'responder'})
    if (item.expected.reportTiming && item.expected.reportTiming!==row.route.delegation?.reportTiming) failures.push({caseId:row.caseId,reason:'report_timing'})
    const active=!['ignore','observe'].includes(row.route.action ?? '')
    if (active && item.expected.intervene===false) falseIntervention++
    if (!active && item.expected.intervene===false) intentionalNonIntervention++
    if (!active && item.expected.intervene===true) missedIntervention++
  }
  latencies.sort((a,b)=>a-b)
  const totals=groupDecisionTotals(allDecisions)
  // Invalid and missing decisions remain in the fixed dataset denominator.
  // Coverage/abstentions expose the difference between no judgment and quiet success.
  const observedIds=new Set(results.map(row=>row.caseId))
  return { cases:GROUP_REPLAY_CASE_IDS.length,observed:results.length,observationCoverage:results.length/GROUP_REPLAY_CASE_IDS.length,
    measured,coverage:measured/GROUP_REPLAY_CASE_IDS.length,accuracyDenominator:GROUP_REPLAY_CASE_IDS.length,
    actionAccuracy:results.length?actionCorrect/GROUP_REPLAY_CASE_IDS.length:null,
    responderAccuracy:results.length?responderCorrect/GROUP_REPLAY_CASE_IDS.length:null,
    abstentions,unresolvedPositive,unresolvedNegative,intentionalNonIntervention,
    missingCaseIds:GROUP_REPLAY_CASE_IDS.filter(id=>!observedIds.has(id)),falseIntervention,missedIntervention,failures,
    logicalReplays:results.length,decisionCalls:totals.decisionCalls,
    decisionLatency:{scope:'provider-request' as const,samples:latencies.length,p50Ms:latencies.length?latencies[Math.floor((latencies.length-1)*0.5)]:null,p95Ms:latencies.length?latencies[Math.ceil((latencies.length-1)*0.95)]:null},
    cost:{scope:'routing-decision-chain' as const,...totals.decisionCost,completeTotalUsd:totals.decisionCostUsd,knownObservations:totals.decisionCost.knownCalls,unknownObservations:totals.decisionCost.unknownCalls},
    runtimeCasesExcluded:[...GROUP_REPLAY_RUNTIME_CASE_IDS],executionMeasured:false as const,productionAccepted:false as const,policyChanged:false as const }
}
