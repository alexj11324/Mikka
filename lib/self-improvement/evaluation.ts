import { createHash } from 'node:crypto'
import { z } from 'zod'
import { skillArtifactRefSchema, skillMarkdown } from '@mikka/protocol/skill'
import type { DecisionContext } from '../coordinator/decision'
import { judgeSkillEffect, type SkillEffectAssessment } from './semantic-assessment'
export { EFFECT_QUESTIONS } from './semantic-assessment'
import type { invokeDecision, DecisionExecution } from '../coordinator/decide'
import { BASELINE_ARTIFACT, BASELINE_MARKDOWN, BASELINE_SKILL } from './builtin-skill'
import { BENCHMARK, BENCHMARK_DIGEST, pendingCandidateComparison, type SkillCandidate } from './regression'

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const observationSchema = z.object({
  runId: z.uuid(), sessionId: z.string().min(1).max(200), sha: z.string().regex(/^[a-f0-9]{40}$/),
  environment: z.string().min(1).max(2000), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  documentDigest: hashSchema, artifact: skillArtifactRefSchema,
  cases: z.array(z.object({ id: z.string(), output: z.string().min(1).max(16000), sha256: hashSchema }).strict()).length(BENCHMARK.cases.length),
  images: z.array(z.object({ dataUrl: z.string(), sha256: hashSchema, capturedAt: z.iso.datetime() }).strict()).max(8),
}).strict()
const comparisonSchema = z.object({
  benchmarkDigest: z.literal(BENCHMARK_DIGEST), requiresVisual: z.boolean(),
  baseline: observationSchema, candidate: observationSchema,
}).strict()
export type TrustedSkillComparison = z.infer<typeof comparisonSchema>
export interface EvaluationProposal { id: string; issueId: string; candidate: SkillCandidate }
export interface ComparisonRequest {
  userId: string; proposalId: string; issueId: string; benchmarkDigest: string;
  baselineDigest: string; candidateDigest: string;
}
export interface ImprovementEvaluationDependencies {
  /** Server-owned collector only: authenticate actual runs/sessions, immutable
   * artifact versions, fixed tasks and captured image provenance. HTTP/model
   * reports, labels or caller-supplied refs cannot implement this boundary. */
  loadComparison?: (request: ComparisonRequest) => Promise<TrustedSkillComparison | null>
  invokeDecision?: typeof invokeDecision
}
/** This host capability is injected, never parsed from an HTTP command. Model
 * judgments describe effect only and cannot satisfy independent Factory gates. */
export function createImprovementEvaluator(deps: ImprovementEvaluationDependencies = {}) {
  return async (userId: string, proposal: EvaluationProposal):Promise<SkillEffectAssessment> => {
    const pending = pendingCandidateComparison(proposal.candidate)
    const unknown = (reason: string, execution: DecisionExecution | null = null) =>
      ({ ...pending, reason, execution, evidenceDigest: null as string | null })
    if (!deps.loadComparison) return unknown('trusted_comparison_unavailable')
    if (!deps.invokeDecision) return unknown('decision_model_unavailable')
    try {
      const collected = await deps.loadComparison({ userId, issueId: proposal.issueId, proposalId: proposal.id,
        benchmarkDigest: BENCHMARK_DIGEST, baselineDigest: pending.baselineDigest, candidateDigest: pending.candidateDigest })
      const parsed = comparisonSchema.safeParse(collected)
      if (!parsed.success) return unknown('trusted_comparison_unavailable')
      const comparison = parsed.data
      const sides = [comparison.baseline, comparison.candidate]
      const expectedBytes = [BASELINE_MARKDOWN, skillMarkdown({ ...BASELINE_SKILL, instructions: proposal.candidate.content.trim() })]
      if (sides[0].runId === sides[1].runId || sides[0].sessionId === sides[1].sessionId ||
        sides[0].environment !== sides[1].environment ||
        sides[0].artifact.versionId !== BASELINE_ARTIFACT.versionId || sides[1].artifact.versionId === sides[0].artifact.versionId)
        return unknown('comparison_binding_mismatch')
      for (const [index, side] of sides.entries()) {
        if (side.documentDigest !== (index ? pending.candidateDigest : pending.baselineDigest) ||
          side.artifact.registryId !== BASELINE_ARTIFACT.registryId || side.artifact.skillId !== BASELINE_ARTIFACT.skillId ||
          side.artifact.format !== BASELINE_ARTIFACT.format || side.artifact.sha256 !== sha256(expectedBytes[index]) ||
          Date.parse(side.startedAt) > Date.parse(side.finishedAt) || Date.parse(side.finishedAt) > Date.now() ||
          new Set(side.cases.map(item => item.id)).size !== BENCHMARK.cases.length ||
          BENCHMARK.cases.some(item => !side.cases.some(value => value.id === item.id)) ||
          side.cases.some(item => sha256(item.output) !== item.sha256) ||
          (comparison.requiresVisual && !side.images.length)) return unknown('comparison_binding_mismatch')
        for (const image of side.images) {
          const bytes = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64')
          if (sha256(bytes) !== image.sha256 || Date.parse(image.capturedAt) < Date.parse(side.startedAt) ||
            Date.parse(image.capturedAt) > Date.parse(side.finishedAt)) return unknown('comparison_binding_mismatch')
        }
      }
      const images = sides.flatMap(side => side.images.map(image => ({ dataUrl: image.dataUrl })))
      const input: DecisionContext = { text: JSON.stringify({
        purpose: 'Judge Skill effectiveness; do not change or authorize anything.',
        proposalId: proposal.id, issueId: proposal.issueId, benchmark: BENCHMARK,
        documents: { baseline: proposal.candidate.baseline, candidate: proposal.candidate.content },
        // Describe image order/bindings, but submit the actual bytes separately.
        comparison: { ...comparison, baseline: { ...sides[0], images: sides[0].images.map(({ dataUrl: _bytes, ...ref }) => ref) },
          candidate: { ...sides[1], images: sides[1].images.map(({ dataUrl: _bytes, ...ref }) => ref) } },
      }), images, requiresVisual: comparison.requiresVisual }
      return judgeSkillEffect({ ...pending, execution:null, evidenceDigest:sha256(JSON.stringify(comparison)) },input,deps.invokeDecision)
    } catch {
      return unknown('comparison_unavailable')
    }
  }
}
export type ImprovementEvaluator = (userId:string,proposal:EvaluationProposal)=>Promise<SkillEffectAssessment>
