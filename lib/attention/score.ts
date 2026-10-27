import 'server-only'
import { runComposioAction } from '@/lib/composio'
import { decide } from '@/lib/coordinator/decide'
import { decisionInput } from '@/lib/coordinator/decision'
import type { SuggestionDecider } from '@/lib/db/schema'
import type { ExternalNotification } from '@/lib/suggestions/notification'
import { attentionQuestions, attentionState, fallbackLevel, readJudgment, ruleLevel, type Assessment, type AttentionLevel, type MatterContext } from './judgment'

/** An unclear answer is judged again at most this many times, each with more of the source than before. */
export const UNCLEAR_REJUDGMENTS = 2
const SOURCE_MAX = 6000

export interface Score {
  level: AttentionLevel
  decidedBy: SuggestionDecider
  assessment: Assessment | null
  /** The earlier matter (by id) the model says this continues. */
  continues: string | null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * More of the source than the notification carried, read through the
 * person's own connection: the whole mail, or the whole Slack thread. Null
 * when the source has nothing more or the read fails.
 */
async function fullSource(notification: ExternalNotification): Promise<string | null> {
  try {
    if (notification.source === 'gmail') {
      const result = await runComposioAction(notification.userId, 'read_gmail_message', { message_id: notification.externalId })
      if ('error' in result) return null
      const data = result.data
      const body = text(data.messageText) || text(data.message_text) || text((data.preview as Record<string, unknown> | undefined)?.body)
      return body ? `from: ${text(data.sender) || notification.actor || ''}\nsubject: ${text(data.subject) || notification.title}\n${body}`.slice(0, SOURCE_MAX) : null
    }
    if (notification.source === 'slack') {
      const [, channel, ts] = notification.matterKey.split(':')
      if (!channel || !ts) return null
      const result = await runComposioAction(notification.userId, 'read_slack_thread', { channel, ts, limit: 30 })
      if ('error' in result) return null
      const messages = Array.isArray(result.data.messages) ? result.data.messages as Record<string, unknown>[] : []
      const thread = messages.map(message => `${text(message.user) || text(message.username) || 'someone'}: ${text(message.text)}`).join('\n')
      return thread ? thread.slice(0, SOURCE_MAX) : null
    }
  } catch (error) {
    console.error('Attention reread failed', error instanceof Error ? error.message : error)
  }
  return null
}

/**
 * Rates one notification. Fixed rules first; then the decision model, floored
 * by code. An unclear answer rereads the source and judges again, at most
 * UNCLEAR_REJUDGMENTS times; still unclear, it stays in 建议 as normal and is
 * not handed over (when unsure, quiet). Never throws.
 */
export async function scoreNotification(notification: ExternalNotification, matters: readonly MatterContext[], same: MatterContext | null, now = new Date()): Promise<Score> {
  const ruled = ruleLevel(notification)
  if (ruled) return { level: ruled, decidedBy: 'rule', assessment: null, continues: null }
  let current = notification
  for (let attempt = 0; attempt <= UNCLEAR_REJUDGMENTS; attempt++) {
    const answers = await decide('attention', decisionInput(attentionState(current, now, matters, same)), attentionQuestions(matters))
    const judgment = answers && readJudgment(answers, now.getTime() - current.occurredAt.getTime(), matters.map(matter => matter.id))
    if (!judgment) return { level: fallbackLevel(notification), decidedBy: 'fallback', assessment: null, continues: null }
    if (judgment.level !== 'unclear') return { level: judgment.level, decidedBy: 'model', assessment: judgment.assessment, continues: judgment.continues }
    if (attempt === UNCLEAR_REJUDGMENTS) break
    const fuller = await fullSource(current)
    if (!fuller || fuller.length <= current.excerpt.length) break
    current = { ...current, excerpt: fuller }
  }
  return { level: 'normal', decidedBy: 'model', assessment: null, continues: null }
}
