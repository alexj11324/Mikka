import 'server-only'
import { pushInput, pushQuestions, pushTask, readPush, type InboxEvent } from '@/lib/push-reasons'

/**
 * Pushes `text` to the person's phones when the Decisions API says it is worth
 * a notification for these events (lib/push-reasons.ts), as their 通知 settings
 * and chat mute allow (lib/mobile-push.ts). No answer pushes nothing.
 */
export async function pushByDecision(userId: string, botId: string, text: string | null, events: readonly InboxEvent[]) {
  // Loaded here: only a push needs the sender, its settings and the Decisions call.
  const [{ pushReply }, { decide }, { hostedBillingScope }, { executionWorkspace }] = await Promise.all([import('@/lib/mobile-push'), import('@/lib/coordinator/decide'), import('@/lib/abuse/context'), import('@/lib/execution-settings')])
  let answers = null
  try { answers = await hostedBillingScope.run({ workspaceId: await executionWorkspace(userId, botId), ownerId: userId }, () => decide('push-reply', pushInput(events, text), pushQuestions())) } catch { answers = null }
  const reason = readPush(answers)
  if (reason === null) { console.warn('Phone push skipped: no Decisions answer'); return }
  if (reason !== 'none') await pushReply(userId, botId, text, [reason], pushTask(events, reason))
}
