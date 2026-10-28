import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { validatedAnswers, decisionRequestInput, DECISION_MODEL, DECISIONS_URL, type DecisionInput, type DecisionQuestion } from './decision'

const DECISION_TIMEOUT_MS = 5000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** Issued by this host after a successful, validated provider response. Never
 * construct one from model prose, a screenshot label, peer data or a tool arg.
 * Submitted pixels and a provider receipt do not prove visual understanding. */
export interface DecisionExecution {
  executionId: string
  modelId: typeof DECISION_MODEL
  providerGenerationId: string
  startedAt: string
  completedAt: string
  requestDigest: string
  imageDigests: string[]
  vision: 'image-input-submitted' | 'no-image-input'
}
/** Existing key/budget only. No alternate provider, program judgment or human-approval fallback. */
export async function invokeDecision(purpose: string, input: DecisionInput, questions: DecisionQuestion[], signal?: AbortSignal) {
  const key = process.env.DECISION_GATEWAY_API_KEY
  if (!key || signal?.aborted) return null
  try {
    const requestInput = decisionRequestInput(input)
    const body = JSON.stringify({ model: DECISION_MODEL, input: requestInput, questions })
    const executionId = randomUUID(), startedAt = new Date().toISOString()
    const response = await fetch(DECISIONS_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.any([AbortSignal.timeout(DECISION_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    })
    if (!response.ok) { await response.body?.cancel(); throw Error('decisionProviderUnavailable') }
    const payload: unknown = await response.json()
    const answers = validatedAnswers(payload, questions)
    // These fields come from the response envelope, not an answer or input.
    const metadata = payload as { model?: unknown; provider_metadata?: { gateway?: { generationId?: unknown } } }
    const generation = metadata?.provider_metadata?.gateway?.generationId
    if (!answers || signal?.aborted || metadata.model !== DECISION_MODEL || typeof generation !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(generation)) return null
    const images = typeof input === 'string' ? [] : input.images ?? []
    const imageDigests = images.map(image => createHash('sha256').update(Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64')).digest('hex'))
    const execution: DecisionExecution = {
      executionId, modelId: DECISION_MODEL, providerGenerationId: generation,
      startedAt, completedAt: new Date().toISOString(), requestDigest: hash(body),
      imageDigests, vision: imageDigests.length ? 'image-input-submitted' : 'no-image-input',
    }
    return { answers, execution }
  } catch {
    // No upstream text, credentials, image bytes or untrusted purpose in logs.
    console.error('Decision unavailable', { purpose: purpose.replace(/[^a-z0-9_-]/gi, '').slice(0, 80) })
    return null
  }
}
/** Compatibility for callers that need answers only. Use invokeDecision when
 * binding a downstream operation/evaluation to the actual model invocation. */
export async function decide(purpose: string, input: DecisionInput, questions: DecisionQuestion[], signal?: AbortSignal) {
  return (await invokeDecision(purpose, input, questions, signal))?.answers ?? null
}

/** Structural adapter for existing server-owned consumers (for example the
 * monitor owner). This is not an HTTP/client approval or permission endpoint. */
export interface DecisionTransportRequest {
  model: typeof DECISION_MODEL
  input: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }>
  questions: DecisionQuestion[]
}
export async function callDecisionRequest(request: DecisionTransportRequest, signal?: AbortSignal) {
  if (request.model !== DECISION_MODEL || request.input[0]?.type !== 'input_text' || request.input.slice(1).some(part => part.type !== 'input_image')) return null
  const result = await invokeDecision('consumer-judgment', {
    text: request.input[0].text,
    images: request.input.slice(1).map(part => ({ dataUrl: (part as { type: 'input_image'; image_url: string }).image_url })),
  }, request.questions, signal)
  if (!result) return null
  return { answers: [...result.answers.values()], invocationId: result.execution.providerGenerationId, execution: result.execution }
}
