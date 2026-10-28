import { z } from 'zod'
import { DECISION_MODEL } from '../coordinator/decision'
import { digest, ImprovementError } from './contract'
import { EFFECT_SCORER, type SkillEffectAssessment } from './semantic-assessment'
import type { RegisteredAssessment, RegisteredSkillEvaluator } from './registered-evaluation'

/** Only mechanical identities and evidence digests. No model or object I/O
 * belongs in the transaction that reads/revalidates this snapshot. */
export interface EvaluationComparisonSnapshot {
  evaluationId:string;instanceId:string;proposalId:string;candidateVersionId:string;
  scope:{issueId:string;agentId:string;repoId:string;sourceCommit:string;factoryTaskId:string;candidateId:string};
  instanceDigest:string;baselineSha256:string;candidateSha256:string;evidenceDigest:string;
}
export interface ModelEvaluationResult {
  kind:'registered-skill-model-v1';evaluationId:string;instanceId:string;proposalId:string;candidateVersionId:string;
  scope:EvaluationComparisonSnapshot['scope'];evidenceDigest:string;comparisonSnapshotDigest:string;
  passed:boolean;semantic:SkillEffectAssessment;independentVerification:false;productionEligible:false;
}
export type StoredEvaluation={result:unknown;digest:string}
const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)

/** Reject historical CPU/keyword results rather than relabeling them as a
 * model invocation. The immutable historical row remains untouched. */
export function isModelEvaluationResult(value:unknown):value is ModelEvaluationResult {
  if(!value||typeof value!=='object')return false
  const r=value as ModelEvaluationResult,s=r.semantic,e=s?.execution
  return r.kind==='registered-skill-model-v1'&&r.independentVerification===false&&r.productionEligible===false&&
    !!s&&s.kind==='semantic_skill_comparison'&&s.status==='assessed'&&
    ['improved','not_improved','regressed'].includes(s.outcome)&&s.reason==='model_assessment'&&
    s.independentVerification===false&&s.productionEligible===false&&digest(s.scorer)===digest(EFFECT_SCORER)&&
    s.improved===(s.outcome==='improved')&&s.noRegression===(s.outcome!=='regressed')&&
    r.passed===(s.improved===true&&s.noRegression===true)&&sha(s.evidenceDigest)&&
    sha(s.artifactBaselineSha256)&&sha(s.artifactCandidateSha256)&&sha(r.comparisonSnapshotDigest)&&
    !!e&&z.uuid().safeParse(e.executionId).success&&e.modelId===DECISION_MODEL&&
    typeof e.providerGenerationId==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(e.providerGenerationId)&&sha(e.requestDigest)&&
    Number.isFinite(Date.parse(e.startedAt))&&Number.isFinite(Date.parse(e.completedAt))&&
    Date.parse(e.startedAt)<=Date.parse(e.completedAt)&&Array.isArray(e.imageDigests)&&
    e.imageDigests.every(sha)&&e.vision===(e.imageDigests.length?'image-input-submitted':'no-image-input')
}
export function currentModelEvaluation(stored:StoredEvaluation,snapshot:EvaluationComparisonSnapshot):ModelEvaluationResult {
  const result=stored.result
  if(!isModelEvaluationResult(result)||stored.digest!==digest(result)||
    result.comparisonSnapshotDigest!==digest(snapshot)||result.evidenceDigest!==snapshot.evidenceDigest||
    result.evaluationId!==snapshot.evaluationId||result.instanceId!==snapshot.instanceId||
    result.proposalId!==snapshot.proposalId||result.candidateVersionId!==snapshot.candidateVersionId||
    digest(result.scope)!==digest(snapshot.scope)||result.semantic.benchmarkDigest!==snapshot.instanceDigest||
    result.semantic.artifactBaselineSha256!==snapshot.baselineSha256||result.semantic.artifactCandidateSha256!==snapshot.candidateSha256)
    throw new ImprovementError('sourceMismatch')
  return result
}
function boundAssessment(assessment:RegisteredAssessment,snapshot:EvaluationComparisonSnapshot) {
  return digest(assessment.registeredBinding)===digest({evaluationId:snapshot.evaluationId,instanceId:snapshot.instanceId,
    proposalId:snapshot.proposalId,issueId:snapshot.scope.issueId,candidateVersionId:snapshot.candidateVersionId,sourceCommit:snapshot.scope.sourceCommit})&&
    assessment.benchmarkDigest===snapshot.instanceDigest&&assessment.artifactBaselineSha256===snapshot.baselineSha256&&
    assessment.artifactCandidateSha256===snapshot.candidateSha256
}
export interface ComparisonState {snapshot:EvaluationComparisonSnapshot;stored:StoredEvaluation|null}
export interface ComparisonDependencies {
  // Each callback owns a short transaction and releases it before returning.
  read:()=>Promise<ComparisonState>
  commit:(before:EvaluationComparisonSnapshot,result:ModelEvaluationResult)=>Promise<ModelEvaluationResult>
  assess?:RegisteredSkillEvaluator
}
/** Pending is a transient read result. Never occupy the append-only result
 * slot with unknown evidence, or call a model while activation holds locks. */
export async function compareRegisteredEvaluation(userId:string,dependencies:ComparisonDependencies):Promise<ModelEvaluationResult> {
  const {snapshot,stored}=await dependencies.read()
  if(stored)return currentModelEvaluation(stored,snapshot)
  const pending:RegisteredAssessment={kind:'semantic_skill_comparison',benchmark:null,benchmarkDigest:snapshot.instanceDigest,
    baselineDigest:'',candidateDigest:'',status:'pending',outcome:'unknown',reason:'decision_model_unavailable',
    noRegression:null,improved:null,execution:null,evidenceDigest:null,scorer:EFFECT_SCORER,independentVerification:false,productionEligible:false}
  let semantic:RegisteredAssessment=pending
  try { semantic=await dependencies.assess?.(userId,{id:snapshot.proposalId,issueId:snapshot.scope.issueId,evaluationId:snapshot.evaluationId})??pending }
  catch { semantic={...pending,reason:'comparison_unavailable'} }
  const record:ModelEvaluationResult={kind:'registered-skill-model-v1',evaluationId:snapshot.evaluationId,instanceId:snapshot.instanceId,
    proposalId:snapshot.proposalId,candidateVersionId:snapshot.candidateVersionId,scope:snapshot.scope,evidenceDigest:snapshot.evidenceDigest,
    comparisonSnapshotDigest:digest(snapshot),passed:semantic.improved===true&&semantic.noRegression===true,
    semantic,independentVerification:false,productionEligible:false}
  if(!boundAssessment(semantic,snapshot)||!isModelEvaluationResult(record)) {
    // Revalidate permissions/current lineage even for transient pending output.
    const after=await dependencies.read()
    if(digest(after.snapshot)!==digest(snapshot))throw new ImprovementError('sourceMismatch')
    if(after.stored)return currentModelEvaluation(after.stored,after.snapshot)
    return {...record,passed:false,semantic:boundAssessment(semantic,snapshot)&&semantic.status==='pending'
      ? {...semantic,improved:null,noRegression:null}
      : {...pending,reason:semantic.status==='pending'?semantic.reason:'assessment_binding_mismatch'}}
  }
  return dependencies.commit(snapshot,record)
}
