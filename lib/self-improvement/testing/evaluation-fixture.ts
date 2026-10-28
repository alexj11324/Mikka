import { createHash, randomUUID } from 'node:crypto'
import { DECISION_MODEL, decisionRequestInput, type DecisionAnswer } from '../../coordinator/decision'
import type { invokeDecision } from '../../coordinator/decide'
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
/** Synthetic transport only, never evidence of an actual provider run. */
export function syntheticDecision(choice = 'improved', confidence?: number): typeof invokeDecision {
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
