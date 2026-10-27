import 'server-only'
import { start } from 'workflow/api'
import { releaseAttention } from '@/lib/attention/store'
import { hasWakingEvents, setEventTier, untriagedEvents, wakingChats } from '@/lib/coordinator/store'
import { decide } from '@/lib/coordinator/decide'
import { decisionInput } from '@/lib/coordinator/decision'
import { ruleTier, tierFromDecision, triageQuestions, triageState } from '@/lib/coordinator/triage'
import type { CoordinatorEventTier } from '@/lib/db/schema'
import { coordinatorTurn } from '@/workflows/coordinator/workflow'

/**
 * Whether the Coordinator runs here: on Vercel (the AI Gateway signs in with
 * the deployment's OIDC token) or wherever a gateway key is set. Elsewhere,
 * events still collect in the inbox and wait.
 */
export function coordinatorEnabled(): boolean {
  return process.env.MIKKA_NATIVE_COORDINATOR === '1' || process.env.VERCEL === '1' || Boolean(process.env.AI_GATEWAY_API_KEY)
}

/** Asks the decision model whether an event needs the person. When it does not answer, the event gets its quiet tier. */
async function decideTier(event: Parameters<typeof triageState>[0]): Promise<CoordinatorEventTier> {
  const answer = (await decide('triage', decisionInput(triageState(event)), triageQuestions(event)))?.get('needsPerson')
  if (answer?.type === 'predicate') return tierFromDecision(answer.probability, event.kind)
  return event.kind === 'run_report' ? 'background' : 'result'
}

/** Gives every untriaged event in the inbox its tier. */
async function triageInbox(userId: string, botId: string | null): Promise<void> {
  for (const event of await untriagedEvents(userId, botId)) {
    await setEventTier(event.id, ruleTier(event) ?? await decideTier(event))
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
