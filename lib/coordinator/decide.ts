import { gatewayCost,gatewayGenerationId } from '@/lib/abuse/policy'
import 'server-only'
import { gatewayAuth } from '@/lib/ai-gateway-auth'
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
/** Existing gateway/budget only. No alternate provider, program judgment or human-approval fallback. */
export async function invokeDecision(purpose: string, input: DecisionInput, questions: DecisionQuestion[], signal?: AbortSignal) {
  'use step'
  if (signal?.aborted) return null
  // The app's one gateway credential (lib/ai-gateway-auth.ts), the same the Coordinator's model uses.
  const key = (await gatewayAuth())?.token
  if (!key) { console.error('Decision unavailable', { purpose: 'no-gateway-auth' }); return null }
  const { hostedBillingScope } = await import('@/lib/abuse/context')
  const scope = hostedBillingScope.getStore()
  if (!scope) return null
  const { assertUnmanagedModelTransport } = await import('@/lib/model-admission/runtime')
  await assertUnmanagedModelTransport(scope, DECISION_MODEL, signal)
  const usage = await import('@/lib/abuse/runtime')
  const callId = randomUUID()
  await usage.canUseMikkaPaid(scope.workspaceId)
  await usage.hostedUsage.reserve(scope.workspaceId,DECISION_MODEL,callId)
  let requestStarted = false
  try {
    const requestInput = decisionRequestInput(input)
    const requestedQuestions = structuredClone(questions)
    const body = JSON.stringify({ model: DECISION_MODEL, input: requestInput, questions: requestedQuestions })
    // Snapshot the same normalized bytes as body before yielding to I/O. The
    // caller may mutate its image objects while this request is in flight.
    const imageDigests = typeof requestInput === 'string' ? [] : requestInput.flatMap(message => message.content.flatMap(part => part.type === 'input_image'
      ? [createHash('sha256').update(Buffer.from(part.image_url.slice(part.image_url.indexOf(',') + 1), 'base64')).digest('hex')]
      : []))
    const executionId = randomUUID(), startedAt = new Date().toISOString()
    await assertUnmanagedModelTransport(scope, DECISION_MODEL, signal)
    if (signal?.aborted) throw new DOMException('Model request cancelled', 'AbortError')
    requestStarted = true
    const response = await fetch(DECISIONS_URL, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.any([AbortSignal.timeout(DECISION_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    })
    if (!response.ok) { await response.body?.cancel(); throw Error('decisionProviderUnavailable') }
    const payload: unknown = await response.json()
    {
      const receipt = payload as {provider_metadata?:unknown}
      await usage.hostedUsage.settle(callId,gatewayCost(receipt.provider_metadata),0,0,gatewayGenerationId(receipt.provider_metadata))
      await (await import('@/lib/abuse/alerts')).checkAbuseAlerts()
    }
    const answers = validatedAnswers(payload, requestedQuestions)
    // These fields come from the response envelope, not an answer or input.
    const metadata = payload as { model?: unknown; provider_metadata?: { gateway?: { generationId?: unknown } } }
    const generation = metadata?.provider_metadata?.gateway?.generationId
    if (!answers || signal?.aborted || metadata.model !== DECISION_MODEL || typeof generation !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(generation)) return null
    const execution: DecisionExecution = {
      executionId, modelId: DECISION_MODEL, providerGenerationId: generation,
      startedAt, completedAt: new Date().toISOString(), requestDigest: hash(body),
      imageDigests, vision: imageDigests.length ? 'image-input-submitted' : 'no-image-input',
    }
    return { answers, execution }
  } catch {
    await usage.hostedUsage.settle(callId,requestStarted ? null : 0)
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
