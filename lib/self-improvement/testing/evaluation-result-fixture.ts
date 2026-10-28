import { randomUUID } from 'node:crypto'
import { DECISION_MODEL } from '../../coordinator/decision'
import { digest } from '../contract'
import { EFFECT_SCORER } from '../semantic-assessment'
import type { EvaluationComparisonSnapshot, ModelEvaluationResult } from '../evaluation-comparison'
/** Fabricated transport/result for isolated tests. Never a real invocation,
 * baseline improvement, or authorization to activate a Skill. */
export function syntheticModelResult(snapshot:EvaluationComparisonSnapshot):ModelEvaluationResult {
  return {kind:'registered-skill-model-v1',evaluationId:snapshot.evaluationId,instanceId:snapshot.instanceId,
    proposalId:snapshot.proposalId,candidateVersionId:snapshot.candidateVersionId,scope:snapshot.scope,
    evidenceDigest:snapshot.evidenceDigest,comparisonSnapshotDigest:digest(snapshot),passed:true,
    independentVerification:false,productionEligible:false,
    semantic:{kind:'semantic_skill_comparison',benchmark:null,benchmarkDigest:snapshot.instanceDigest,
      baselineDigest:'1'.repeat(64),candidateDigest:'2'.repeat(64),artifactBaselineSha256:snapshot.baselineSha256,
      artifactCandidateSha256:snapshot.candidateSha256,status:'assessed',outcome:'improved',reason:'model_assessment',
      noRegression:true,improved:true,evidenceDigest:'3'.repeat(64),scorer:EFFECT_SCORER,
      independentVerification:false,productionEligible:false,execution:{executionId:randomUUID(),modelId:DECISION_MODEL,
        providerGenerationId:'synthetic-generation',startedAt:'2026-01-01T00:00:00.000Z',completedAt:'2026-01-01T00:00:01.000Z',
        requestDigest:'4'.repeat(64),imageDigests:[],vision:'no-image-input'}}}
}
