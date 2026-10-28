import 'server-only'
import { start } from 'workflow/api'
import { releaseAttention } from '@/lib/attention/store'
import { hasWakingEvents, setEventTier, untriagedEvents, wakingChats } from '@/lib/coordinator/store'
import { invokeDecision } from '@/lib/coordinator/decide'
import { ruleTier, tierFromDecision, triageQuestions, triageInput } from '@/lib/coordinator/triage'
import { coordinatorTurn } from '@/workflows/coordinator/workflow'

/**
 * Whether the Coordinator runs here: on Vercel (the AI Gateway signs in with
 * the deployment's OIDC token) or wherever a gateway key is set. Elsewhere,
 * events still collect in the inbox and wait.
 */
export function coordinatorEnabled(): boolean {
  return process.env.MIKKA_NATIVE_COORDINATOR === '1' || process.env.VERCEL === '1' || Boolean(process.env.AI_GATEWAY_API_KEY)
}

/** No answer leaves the event pending; it does not become background, result or a request for human approval. */
export async function triageInbox(userId: string, botId: string | null = null): Promise<void> {
  // Retry only this classification, at most twice within a ten-second inbox
  // budget. No answer is persisted as a business outcome. A later wake can
  // revisit the still-untriaged event without duplicating delivery.
  const budget = AbortSignal.timeout(10_000)
  for (const event of await untriagedEvents(userId, botId)) {
    let tier = ruleTier(event)
    for (let attempt = 0; tier === null && attempt < 2 && !budget.aborted; attempt++) {
      const result = await invokeDecision('triage', triageInput(event), triageQuestions(event), budget)
      tier = tierFromDecision(result?.answers.get('tier'))
      if (result && tier !== null) console.info('Coordinator model judgment observed', { eventId: event.id, ...result.execution })
    }
    if (tier === null) {
      console.error('Coordinator event judgment pending', { eventId: event.id })
      continue
    }
    await setEventTier(event.id, tier, { userId, botId })
  }
}

/**
 * Hands over the next waiting matter from connected apps (a snooze that is
 * due included) to the Coordinator, then triages the inbox and starts a turn
 * for each of the person's chats (the Coordinator's and any bot's) unless all
 * that waits there is background. Call it after the event is committed.
 * Never throws: an event whose wake fails waits for the next one.
 */
export async function wakeCoordinator(userId: string): Promise<void> {
  if (!coordinatorEnabled()) return
  try {
    await releaseAttention(userId)
    for (const botId of await wakingChats(userId)) {
      await triageInbox(userId, botId)
      if (await hasWakingEvents(userId, botId)) await start(coordinatorTurn, [userId, botId])
    }
  } catch (error) {
    console.error('Failed to wake the Coordinator', error instanceof Error ? error.message : error)
  }
}
