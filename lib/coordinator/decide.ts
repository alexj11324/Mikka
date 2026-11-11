import { gatewayCost,gatewayGenerationId } from '@/lib/abuse/policy'
import 'server-only'
import { gatewayAuth } from '@/lib/ai-gateway-auth'
import { isCloudEdition } from '@/lib/edition'
import { cloudDecisionTarget } from '@/lib/default-model'
import { CloudServiceError } from '@/lib/cloud-services/errors'
import { createHash, randomUUID } from 'node:crypto'
import { validatedAnswers, decisionRequestInput, DECISION_MODEL, DECISIONS_URL, type DecisionInput, type DecisionQuestion, type DecisionAnswer } from './decision'
import type { HostedModelBilling } from '@/lib/abuse/model'
import { observeAiRequest, type AiMetadata } from '@/lib/tracing/ai'

const DECISION_TIMEOUT_MS = 5000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** Issued by this host after a successful, validated provider envelope. Never
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
export async function invokeDecision(purpose: string, input: DecisionInput, questions: DecisionQuestion[], signal?: AbortSignal, diagnostics?: {retainInvalidReceipt:true}, billingAdapter?: HostedModelBilling) {
  'use step'
  if (signal?.aborted) return null
  const { hostedBillingScope } = await import('@/lib/abuse/context')
  const scope = hostedBillingScope.getStore()
  if (!scope) return null
  const cloud = await cloudDecisionTarget(scope.ownerId)
  // The app's one gateway credential (lib/ai-gateway-auth.ts), the same the Coordinator's model uses.
  const key = cloud ? null : DECISIONS_URL === 'https://ai-gateway.vercel.sh/v1/decisions'
    ? process.env.DECISIONS_API_KEY || (await gatewayAuth())?.token
    : process.env.DECISIONS_API_KEY || process.env.AI_GATEWAY_API_KEY
  if (!cloud && !key) { console.error('Decision unavailable', { purpose: 'no-gateway-auth' }); return null }
  const { assertUnmanagedModelTransport } = await import('@/lib/model-admission/runtime')
  await assertUnmanagedModelTransport(scope, DECISION_MODEL, signal)
  const usage = cloud ? null : await import('@/lib/abuse/runtime')
  const store = billingAdapter?.usage ?? usage?.hostedUsage
  const callId = randomUUID()
  // Like every hosted call (lib/abuse/model.ts): the workspace's own balance first, then shared credits.
  const { withSharedCredits } = await import('@/lib/credit-shares')
  if (store && usage) {
    const billingPrincipal = await withSharedCredits(scope.workspaceId, async payer => {
      await (billingAdapter?.admit ?? usage.canUseMikkaPaid)(payer)
      return { payer, organizationId: hostedBillingScope.getStore()?.billingOrganizationId ?? null }
    })
    await withSharedCredits(scope.workspaceId, payer => store.reserve(payer, DECISION_MODEL, callId), billingPrincipal)
  }
  let requestStarted = false
  try {
    return await observeAiRequest({ modelId: DECISION_MODEL, userId: scope.ownerId, route: 'gateway', operation: 'decision' }, async report => {
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
      const init: RequestInit = {
        method: 'POST',
        redirect: 'error',
        headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.any([AbortSignal.timeout(DECISION_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      }
      const response = cloud && scope.ownerId
        ? await (await import('@/lib/cloud-services/runtime')).cloudRequest(scope.ownerId, 'models', '/v1/decisions', init)
        : await fetch(DECISIONS_URL, init)
      if (!response.ok) { await response.body?.cancel(); throw Error('decisionProviderUnavailable') }
      const payload: unknown = await response.json()
      {
        const receipt = payload as {provider_metadata?:unknown; usage?:unknown}
        const cost = gatewayCost(receipt.provider_metadata)
        const tokens = decisionTokenUsage(receipt.usage)
        report({ usage: tokens, totalCostUsd: cost === null ? null : cost / 1_000_000 })
        // The receipt already carries the real counts; settle them instead of the
        // zeros this used to record, which made every routing decision look free.
        if (store) await store.settle(callId,cost,decisionTokenCount(tokens.inputTokens),decisionTokenCount(tokens.outputTokens),
          gatewayGenerationId(receipt.provider_metadata),
          { read: decisionTokenCountOrNull(tokens.inputTokenDetails.cacheReadTokens), write: decisionTokenCountOrNull(tokens.inputTokenDetails.cacheWriteTokens) })
        if (store && isCloudEdition()) await (await import('@/lib/abuse/alerts')).checkAbuseAlerts()
      }
      const answers = validatedAnswers(payload, requestedQuestions)
      const judgment: AiMetadata = {}
      for (const name of ['tier', 'effort'] as const) {
        const answer = answers?.get(name)
        if (answer?.type === 'score') {
          judgment[`${name}Score`] = answer.score
          judgment[`${name}Confidence`] = answer.confidence
        }
      }
      report({ metadata: judgment, invalid: !answers })
      // These fields come from the response envelope, not an answer or input.
      const metadata = payload as { model?: unknown; provider_metadata?: { gateway?: { generationId?: unknown } } }
      const generation = metadata?.provider_metadata?.gateway?.generationId
      if (signal?.aborted || metadata.model !== DECISION_MODEL || typeof generation !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(generation)) { report({ invalid: true }); return null }
      if (!answers && !diagnostics?.retainInvalidReceipt) return null
      const execution: DecisionExecution = {
        executionId, modelId: DECISION_MODEL, providerGenerationId: generation,
        startedAt, completedAt: new Date().toISOString(), requestDigest: hash(body),
        imageDigests, vision: imageDigests.length ? 'image-input-submitted' : 'no-image-input',
      }
      // Host-only group diagnostics opt in to retaining a paid invalid response.
      // No usable answer is exposed; the default contract of all other callers
      // (including decide/callDecisionRequest) remains null for invalid answers.
      return { answers: answers ?? new Map<string,Exclude<DecisionAnswer,{type:'refusal'}>>(), execution, ...(answers ? {} : {validationFailure:'invalid_response' as const}) }
    }, signal)
  } catch (error) {
    if (store) await store.settle(callId,requestStarted ? null : 0)
    if (cloud && error instanceof CloudServiceError) throw error
    // No upstream text, credentials, image bytes or untrusted purpose in logs.
    console.error('Decision unavailable', { purpose: purpose.replace(/[^a-z0-9_-]/gi, '').slice(0, 80) })
    return null
  }
}

/** Only the numeric usage envelope; answers, images and request digests are never telemetry. */
function decisionTokenUsage(value: unknown) {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rawDetails = usage.input_tokens_details ?? usage.prompt_tokens_details
  const details = rawDetails && typeof rawDetails === 'object' ? rawDetails as Record<string, unknown> : {}
  return {
    inputTokens: usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens,
    outputTokens: usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens,
    inputTokenDetails: { cacheReadTokens: details.cached_tokens, cacheWriteTokens: usage.cache_creation_input_tokens },
  }
}

/**
 * A ledger token total, or 0 when the envelope carried no usable number. These
 * columns have always meant "this call ran", so an absent total stays 0 here.
 */
function decisionTokenCount(value: unknown): number {
  const count = decisionTokenCountOrNull(value)
  return count ?? 0
}

/**
 * A cache count, or null when absent. Absent means the provider reported no cache
 * figure, which is not the same fact as reporting zero, so it must stay null.
 */
function decisionTokenCountOrNull(value: unknown): number | null {
  const count = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isSafeInteger(count) && count >= 0 ? count : null
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
