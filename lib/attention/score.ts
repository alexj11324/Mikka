import 'server-only'
import { runComposioAction } from '@/lib/composio'
import { fullSource } from './source'
import { decide } from '@/lib/coordinator/decide'
import { decisionInput } from '@/lib/coordinator/decision'
import type { ExternalNotification } from '@/lib/suggestions/notification'
import { judgeAttention, type AttentionJudge, type AttentionScore, type MatterContext } from './judgment'

/** An unclear answer is judged again at most this many times, each with more of the source than before. */
export const UNCLEAR_REJUDGMENTS = 2
export type Score = AttentionScore

/** The Decisions API call for one notification, billed to the person's execution workspace. */
const decisionsJudge: AttentionJudge = async (notification, state, questions) => {
  const { hostedBillingScope } = await import('@/lib/abuse/context')
  const { executionWorkspace } = await import('@/lib/execution-settings')
  return hostedBillingScope.run({ workspaceId: await executionWorkspace(notification.userId, null), ownerId: notification.userId }, () => decide('attention', decisionInput(state), questions))
}

/**
 * Rates one notification with the Decisions API and nothing else: no rule
 * runs before it and none stands in for it. Null when the API gives no usable
 * answer; the caller stores nothing, so a later delivery or the hourly
 * backfill judges it again. Never throws.
 */
export async function scoreNotification(notification: ExternalNotification, matters: readonly MatterContext[], same: MatterContext | null, now = new Date()): Promise<Score | null> {
  'use step'
  return judgeAttention(notification, matters, same, now, decisionsJudge, current => fullSource(current, runComposioAction), UNCLEAR_REJUDGMENTS)
}
