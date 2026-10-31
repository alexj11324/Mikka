import 'server-only'
import { runComposioAction } from '@/lib/composio'
import { fullSource } from './source'
import { decide } from '@/lib/coordinator/decide'
import { decisionInput } from '@/lib/coordinator/decision'
import type { SuggestionDecider } from '@/lib/db/schema'
import type { ExternalNotification } from '@/lib/suggestions/notification'
import { attentionQuestions, attentionState, fallbackLevel, readJudgment, ruleLevel, type Assessment, type AttentionLevel, type MatterContext } from './judgment'

/** An unclear answer is judged again at most this many times, each with more of the source than before. */
export const UNCLEAR_REJUDGMENTS = 2
export interface Score {
  level: AttentionLevel
  decidedBy: SuggestionDecider
  assessment: Assessment | null
  /** The earlier matter (by id) the model says this continues. */
  continues: string | null
}


/**
 * Rates one notification. Fixed rules first; then the decision model, floored
 * by code. An unclear answer rereads the source and judges again, at most
 * UNCLEAR_REJUDGMENTS times; still unclear, it stays in 建议 as normal and is
 * not handed over (when unsure, quiet). Never throws.
 */
export async function scoreNotification(notification: ExternalNotification, matters: readonly MatterContext[], same: MatterContext | null, now = new Date()): Promise<Score> {
  'use step'
  const { hostedBillingScope } = await import('@/lib/abuse/context')
  const { executionWorkspace } = await import('@/lib/execution-settings')
  const ruled = ruleLevel(notification)
  if (ruled) return { level: ruled, decidedBy: 'rule', assessment: null, continues: null }
  let current = notification
  for (let attempt = 0; attempt <= UNCLEAR_REJUDGMENTS; attempt++) {
    const answers = await hostedBillingScope.run({workspaceId:await executionWorkspace(notification.userId,null),ownerId:notification.userId},()=>decide('attention', decisionInput(attentionState(current, now, matters, same)), attentionQuestions(matters)))
    const judgment = answers && readJudgment(answers, now.getTime() - current.occurredAt.getTime(), matters.map(matter => matter.id))
    if (!judgment) return { level: fallbackLevel(notification), decidedBy: 'fallback', assessment: null, continues: null }
    if (judgment.level !== 'unclear') return { level: judgment.level, decidedBy: 'model', assessment: judgment.assessment, continues: judgment.continues }
    if (attempt === UNCLEAR_REJUDGMENTS) break
    const fuller = await fullSource(current, runComposioAction)
    if (!fuller || fuller.length <= current.excerpt.length) break
    current = { ...current, excerpt: fuller }
  }
  return { level: 'normal', decidedBy: 'model', assessment: null, continues: null }
}
