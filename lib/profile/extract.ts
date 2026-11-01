import 'server-only'
import { generateText } from 'ai'
import { gatewayAuth } from '@/lib/ai-gateway-auth'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import type { ExternalNotification } from '@/lib/suggestions/notification'
import { extractionPrompt, factInput, parseFacts } from './facts'
import { captureGeneration } from '@/lib/posthog-server'
import { profileEnabled } from './flags'
import { profileEntitled } from './entitlement'
import { claimExtractionCall, memoryEnabled, recordExtractionTokens, recordFacts, usageDay } from './store'

/** The small text model that reads facts; the same flash model that writes action lines. */
const FACT_MODEL = COORDINATOR_MODEL
const FACT_TIMEOUT_MS = 15_000

/**
 * Reads up to three facts about the person from one rated notification and
 * writes them to their profile (R-73). One model call, made only when every
 * switch in proactive.md § 3 allows it: PROACTIVE_PROFILE_ENABLED, the
 * person's PostHog flag, their 记忆 switch, and their daily call cap. Each
 * call and its tokens are recorded in proactive_usage and sent to PostHog as
 * an $ai_generation event (model and tokens only). Like the action lines
 * it signs in with the app's one gateway credential (lib/ai-gateway-auth.ts),
 * and the hosted usage budget caps the spend; without it, or when the call
 * fails, nothing is learnt. The
 * notification text is read here only, never stored. Never throws.
 */
export async function extractFacts(notification: ExternalNotification, suggestionId: string): Promise<number> {
  'use step'
  const { hostedModel, createTrustedGatewayModel } = await import('@/lib/abuse/model')
  const { modelAdmission } = await import('@/lib/model-admission/runtime')
  const { executionWorkspace } = await import('@/lib/execution-settings')
  if (!profileEnabled() || !await gatewayAuth()) return 0
  try {
    if (!await profileEntitled(notification.userId) || !await memoryEnabled(notification.userId)) return 0
    const workspaceId=await executionWorkspace(notification.userId,null)
    await modelAdmission.gateway({workspaceId,ownerId:notification.userId},FACT_MODEL,undefined,{auditAllowed:false})
    const model=await hostedModel(workspaceId,FACT_MODEL,await createTrustedGatewayModel(FACT_MODEL),notification.userId)
    const day = usageDay(new Date())
    if (!await claimExtractionCall(notification.userId, day)) return 0
    const { instructions, prompt } = extractionPrompt(notification)
    const started = Date.now()
    const { text, usage } = await generateText({ model, instructions, prompt, maxRetries: 1, abortSignal: AbortSignal.timeout(FACT_TIMEOUT_MS) })
    const inputTokens = usage.inputTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
    captureGeneration(notification.userId, { model: FACT_MODEL, inputTokens, outputTokens, latencyMs: Date.now() - started, span: 'profile_extraction' })
    await recordExtractionTokens(notification.userId, day, inputTokens, outputTokens)
    const facts = parseFacts(text).map(fact => factInput(fact, notification, suggestionId))
    return facts.length ? await recordFacts(notification.userId, facts) : 0
  } catch (error) {
    console.error('Fact extraction failed', error instanceof Error ? error.message : error)
    return 0
  }
}
