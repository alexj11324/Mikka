import 'server-only'
import { decisionProviderReceipt } from './decision-provider'
import { gatewayLiteLlm } from '../model-gateway/config'
import { liteLLMBaseUrl } from '../model-gateway/litellm-client'
import { isCloudEdition } from '@/lib/edition'
import { createHash, randomUUID } from 'node:crypto'
import { validatedAnswers, decisionRequestInput, DECISION_MODEL, DECISIONS_PATH, type DecisionReceiptModel, type DecisionInput, type DecisionQuestion, type DecisionAnswer } from './decision'
import type { HostedModelBilling } from '@/lib/abuse/model'
import { observeAiRequest, type AiMetadata } from '@/lib/tracing/ai'
import { decisionTimeoutMs } from './decision-timeout'
import { safeErrorAttributes } from '@mikka/protocol/tracing'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** Issued by this host after a successful, validated provider envelope. Never
 * construct one from model prose, a screenshot label, peer data or a tool arg.
 * Submitted pixels and a provider receipt do not prove visual understanding. */
export interface DecisionExecution {
  executionId: string
  modelId: DecisionReceiptModel
  providerGenerationId: string
  startedAt: string
  completedAt: string
  requestDigest: string
  providerRequestDigest?: string
  imageDigests: string[]
  vision: 'image-input-submitted' | 'no-image-input'
}
/** Submit only to the configured Decisions provider after the existing workspace admission check. */
export async function invokeDecision(purpose: string, input: DecisionInput, questions: DecisionQuestion[], signal?: AbortSignal, diagnostics?: {retainInvalidReceipt:true}, billingAdapter?: HostedModelBilling) {
  'use step'
  if (signal?.aborted) return null
  const { hostedBillingScope } = await import('@/lib/abuse/context')
  const scope = hostedBillingScope.getStore()
  if (!scope) return null
  const proxy = gatewayLiteLlm()
  const baseUrl = liteLLMBaseUrl(proxy?.url)
  if (!proxy || !baseUrl) { console.error('Decision unavailable', { purpose: 'litellm-not-configured' }); return null }
  const endpoint = baseUrl + DECISIONS_PATH.slice('/v1'.length)
  const { assertLiteLLMModelTransport } = await import('@/lib/model-admission/runtime')
  await assertLiteLLMModelTransport(scope, DECISION_MODEL, baseUrl, signal)
  const usage = await import('@/lib/abuse/runtime')
  const store = billingAdapter?.usage ?? usage.hostedUsage
  const callId = randomUUID()
  // Like every hosted call (lib/abuse/model.ts): the workspace's own balance first, then shared credits.
  if (store && store.metered !== false) {
    const { withSharedCredits } = await import('@/lib/credit-shares')
    const billingPrincipal = await withSharedCredits(scope.workspaceId, async payer => {
      await (billingAdapter?.admit ?? usage.canUseMikkaPaid)(payer)
      return { payer, organizationId: hostedBillingScope.getStore()?.billingOrganizationId ?? null }
    })
    await withSharedCredits(scope.workspaceId, payer => store.reserve(payer, DECISION_MODEL, callId), billingPrincipal)
  }
  let requestStarted = false
  try {
    return await observeAiRequest({ modelId: DECISION_MODEL, userId: scope.ownerId, route: 'litellm', operation: 'decision' }, async report => {
      const requestInput = decisionRequestInput(input)
      const requestedQuestions = structuredClone(questions)
      const logicalBody = JSON.stringify({ model: DECISION_MODEL, input: requestInput, questions: requestedQuestions })
      // Snapshot the same normalized bytes as body before yielding to I/O. The
      // caller may mutate its image objects while this request is in flight.
      const imageDigests = typeof requestInput === 'string' ? [] : requestInput.flatMap(message => message.content.flatMap(part => part.type === 'input_image'
        ? [createHash('sha256').update(Buffer.from(part.image_url.slice(part.image_url.indexOf(',') + 1), 'base64')).digest('hex')]
        : []))
      const executionId = randomUUID(), startedAt = new Date().toISOString()
      await assertLiteLLMModelTransport(scope, DECISION_MODEL, baseUrl, signal)
      if (signal?.aborted) throw new DOMException('Model request cancelled', 'AbortError')
      requestStarted = true
      const init: RequestInit = {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: 'Bearer ' + proxy.masterKey, 'Content-Type': 'application/json' },
        body: logicalBody,
        signal: AbortSignal.any([AbortSignal.timeout(decisionTimeoutMs()), ...(signal ? [signal] : [])]),
      }
      const response = await fetch(endpoint, init)
      if (!response.ok) {
        const error = new DecisionHttpError(response.status)
        report({ upstreamStatus: error.status, errorMessage: error.message })
        await response.body?.cancel().catch(() => {})
        throw error
      }
      const payload: unknown = await response.json()
      const receipt = decisionProviderReceipt(payload, response.headers)
      {
        const cost = receipt.cost
        const tokens = decisionTokenUsage((payload as {usage?:unknown} | null)?.usage)
        report({ usage: tokens, totalCostUsd: cost === null ? null : cost / 1_000_000 })
        // The receipt already carries the real counts; settle them instead of the
        // zeros this used to record, which made every routing decision look free.
        if (store) await store.settle(callId,cost,decisionTokenCount(tokens.inputTokens),decisionTokenCount(tokens.outputTokens),
          receipt.generation,
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
      const generation = receipt.generation
      if (signal?.aborted || !receipt.modelPresent || !generation || !/^[a-zA-Z0-9_-]{1,200}$/.test(generation)
        || receipt.cost === null) { report({ invalid: true }); return null }
      if (!answers && !diagnostics?.retainInvalidReceipt) return null
      const execution: DecisionExecution = {
        executionId, modelId: DECISION_MODEL, providerGenerationId: generation,
        startedAt, completedAt: new Date().toISOString(), requestDigest: hash(logicalBody),
        imageDigests, vision: imageDigests.length ? 'image-input-submitted' : 'no-image-input',
      }
      // Host-only group diagnostics opt in to retaining a paid invalid response.
      // No usable answer is exposed; the default contract of all other callers
      // (including decide/callDecisionRequest) remains null for invalid answers.
      return { answers: answers ?? new Map<string,Exclude<DecisionAnswer,{type:'refusal'}>>(), execution, ...(answers ? {} : {validationFailure:'invalid_response' as const}) }
    }, signal)
  } catch (error) {
    if (store) await store.settle(callId,requestStarted ? null : 0)
    // No upstream text, credentials, image bytes or untrusted purpose in logs.
    console.error('Decision unavailable', { purpose: purpose.replace(/[^a-z0-9_-]/gi, '').slice(0, 80), ...safeErrorAttributes(error),
      ...(error instanceof DecisionHttpError ? { status: error.status, message: error.message } : {}) })
    return null
  }
}

class DecisionHttpError extends Error {
  constructor(readonly status: number) {
    super(`Decision provider returned HTTP ${status}`)
    this.name = 'DecisionHttpError'
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
    inputTokenDetails: { cacheReadTokens: details.cached_tokens, cacheWriteTokens: details.cache_write_tokens ?? usage.cache_creation_input_tokens },
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
