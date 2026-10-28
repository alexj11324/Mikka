import { createHash, randomUUID } from 'node:crypto'
import { skillMarkdown } from '@mikka/protocol/skill'
import { DECISION_MODEL, decisionRequestInput, type DecisionAnswer } from '../../coordinator/decision'
import { BASELINE_ARTIFACT, BASELINE_SKILL } from '../builtin-skill'
import { BENCHMARK, BENCHMARK_DIGEST, createSkillCandidate } from '../regression'
import type { ImprovementEvaluationDependencies, TrustedSkillComparison } from '../evaluation'

const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
/** Synthetic evidence only. Not a production collector or a real run receipt. */
export function syntheticComparison(): TrustedSkillComparison {
  const candidate = createSkillCandidate()
  const startedAt = new Date(Date.now() - 2000).toISOString(), finishedAt = new Date(Date.now() - 1000).toISOString()
  const observation = (side: string) => ({ runId: randomUUID(), sessionId: `synthetic-${side}`, sha: 'a'.repeat(40),
    environment: 'synthetic-isolated', startedAt, finishedAt,
    documentDigest: side === 'baseline' ? candidate.baselineDigest : candidate.candidateDigest,
    artifact: side === 'baseline' ? BASELINE_ARTIFACT : { ...BASELINE_ARTIFACT, versionId: randomUUID(),
      sha256: hash(skillMarkdown({ ...BASELINE_SKILL, instructions: candidate.content.trim() })) },
    cases: BENCHMARK.cases.map(item => { const output = `Synthetic ${side} observation for ${item.id}; no real quality claim.`
      return { id: item.id, output, sha256: hash(output) } }), images: [],
  })
  return { benchmarkDigest: BENCHMARK_DIGEST, requiresVisual: false, baseline: observation('baseline'), candidate: observation('candidate') }
}
/** Matches the actual #331 request/envelope contract without any fetch/model. */
export function syntheticDecision(choice = 'improved', confidence?: number): NonNullable<ImprovementEvaluationDependencies['invokeDecision']> {
  return async (_purpose, input, questions) => {
    const images = typeof input === 'string' ? [] : input.images ?? []
    const imageDigests = images.map(image => hash(Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64')))
    const answer: Exclude<DecisionAnswer, { type: 'refusal' }> = { type: 'choice', name: 'skill_effect', choice, ...(confidence === undefined ? {} : { confidence }) }
    return { answers: new Map([['skill_effect', answer]]), execution: {
      executionId: randomUUID(), modelId: DECISION_MODEL, providerGenerationId: 'synthetic-generation',
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      requestDigest: hash(JSON.stringify({ model: DECISION_MODEL, input: decisionRequestInput(input), questions })),
      imageDigests, vision: images.length ? 'image-input-submitted' : 'no-image-input',
    } }
  }
}
