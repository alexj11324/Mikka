import { gatewayCost } from '@/lib/abuse/policy'
import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { validatedAnswers, decisionRequestInput, DECISION_MODEL, type DecisionInput, type DecisionQuestion, type DecisionAnswer } from './decision'
import { decisionRequestBody, decisionResponseEnvelope, type DecisionTransport } from './decision-wire'
import { selectDecisionRoute } from './decision-model'

const DECISION_TIMEOUT_MS = 5000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** Issued by this host after a successful, validated provider envelope. Never
 * construct one from model prose, a screenshot label, peer data or a tool arg.
 * Submitted pixels and a provider receipt do not prove visual understanding. */
export interface DecisionExecution {
  executionId: string
  /** Actual provider envelope model, required to equal the outgoing model. */
  modelId: string
  /** Absent only on genuine historical Decisions receipts. */
  transport?: DecisionTransport
  providerGenerationId: string
  startedAt: string
  completedAt: string
  requestDigest: string
  imageDigests: string[]
  vision: 'image-input-submitted' | 'no-image-input'
}
export interface DecisionDiagnostics {
  retainInvalidReceipt?: true
  /** A host-owned acceptance constraint, never supplied by the HTTP client. */
  requireFlash?: true
}
/** One frozen, authorized transport. No model fallback or retry. */
export async function invokeDecision(purpose: string, input: DecisionInput, questions: DecisionQuestion[], signal?: AbortSignal, diagnostics?: DecisionDiagnostics) {
  'use step'
  if (signal?.aborted) return null
  const { hostedBillingScope } = await import('@/lib/abuse/context')
  const scope = hostedBillingScope.getStore()
  if (!scope) return null
  let route: Awaited<ReturnType<typeof selectDecisionRoute>>
  try { route = await selectDecisionRoute(scope) } catch { return null }
  if (!route) { console.error('Decision unavailable', { purpose: 'no-gateway-auth' }); return null }
  if (diagnostics?.requireFlash) {
    const { assertFlashTestModel } = await import('../../scripts/test-model-policy.mjs')
    assertFlashTestModel(route.modelId, 'group-decision-replay')
  }
  const identity = { modelId: route.modelId, transport: route.transport }
  const { assertUnmanagedModelTransport } = await import('@/lib/model-admission/runtime')
  await assertUnmanagedModelTransport(scope, route.modelId, signal)
  const hosted = route.transport === 'gateway-chat-completions'
  const usage = hosted ? await import('@/lib/abuse/runtime') : null
  const callId = randomUUID()
  if (usage) {
    const { withSharedCredits } = await import('@/lib/credit-shares')
    await withSharedCredits(scope.workspaceId, usage.canUseMikkaPaid)
    await withSharedCredits(scope.workspaceId, payer => usage.hostedUsage.reserve(payer, route!.modelId, callId))
  }
  let requestStarted = false, settled = false
  try {
    const requestedInput = structuredClone(input), requestedQuestions = structuredClone(questions)
    const normalized = decisionRequestInput(requestedInput)
    const body = decisionRequestBody(identity, requestedInput, requestedQuestions)
    // Same snapshot as the serialized request; mutations during IO cannot
    // replace questions, pixels or the requested model in the receipt.
    const imageDigests = typeof normalized === 'string' ? [] : normalized.flatMap(message => message.content.flatMap(part => part.type === 'input_image'
      ? [createHash('sha256').update(Buffer.from(part.image_url.slice(part.image_url.indexOf(',') + 1), 'base64')).digest('hex')]
      : []))
    const credential = await route.authorize()
    await assertUnmanagedModelTransport(scope, route.modelId, signal)
    if (signal?.aborted) throw new DOMException('Model request cancelled', 'AbortError')
    const executionId = randomUUID(), startedAt = new Date().toISOString()
    requestStarted = true
    const response = await fetch(credential.url, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + credential.token, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.any([AbortSignal.timeout(DECISION_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    })
    if (!response.ok) { await response.body?.cancel(); throw Error('decisionProviderUnavailable') }
    const payload: unknown = await response.json()
    const envelope = decisionResponseEnvelope(payload, identity)
    if (usage) {
      const receipt = payload as { provider_metadata?: unknown; id?: unknown }
      // Chat Completions returns the Gateway generation as the real response
      // id. Missing cost is unknown and can be reconciled by that id later.
      const generation = typeof receipt.id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(receipt.id) ? receipt.id : undefined
      await usage.hostedUsage.settle(callId, gatewayCost(receipt.provider_metadata), 0, 0, generation)
      settled = true
      await (await import('@/lib/abuse/alerts')).checkAbuseAlerts()
    }
    if (signal?.aborted || !envelope) return null
    const answers = validatedAnswers(envelope.answers, requestedQuestions)
    if (!answers && !diagnostics?.retainInvalidReceipt) return null
    const execution: DecisionExecution = {
      executionId, modelId: envelope.modelId, transport: route.transport, providerGenerationId: envelope.generationId,
      startedAt, completedAt: new Date().toISOString(), requestDigest: hash(body),
      imageDigests, vision: imageDigests.length ? 'image-input-submitted' : 'no-image-input',
    }
    return { answers: answers ?? new Map<string,Exclude<DecisionAnswer,{type:'refusal'}>>(), execution, ...(answers ? {} : {validationFailure:'invalid_response' as const}) }
  } catch {
    // BYOK has no Mikka reservation or charge; its external cost stays unknown.
    if (usage && !settled) await usage.hostedUsage.settle(callId, requestStarted ? null : 0)
    console.error('Decision unavailable', { purpose: purpose.replace(/[^a-z0-9_-]/gi, '').slice(0, 80) })
    return null
  }
}
/** Compatibility for callers that need answers only. */
export async function decide(purpose: string, input: DecisionInput, questions: DecisionQuestion[], signal?: AbortSignal) {
  return (await invokeDecision(purpose, input, questions, signal))?.answers ?? null
}

/** A server-owned logical request. The host resolves the actual authorized
 * API preference; this is not an HTTP/client model override. */
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
