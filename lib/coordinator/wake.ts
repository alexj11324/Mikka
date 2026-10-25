import 'server-only'
import { start } from 'workflow/api'
import { hasWakingEvents, setEventTier, untriagedEvents } from '@/lib/coordinator/store'
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
  return process.env.VERCEL === '1' || Boolean(process.env.AI_GATEWAY_API_KEY)
}

/** Asks the decision model whether an event needs the person. When it does not answer, the event gets its quiet tier. */
async function decideTier(userId: string, event: Parameters<typeof triageState>[0]): Promise<CoordinatorEventTier> {
  const answer = (await decide('triage', decisionInput(triageState(event)), triageQuestions(event), userId))?.get('needsPerson')
  if (answer?.type === 'predicate') return tierFromDecision(answer.probability, event.kind)
  return event.kind === 'run_report' ? 'background' : 'result'
}

/** Gives every untriaged event in the inbox its tier. */
async function triageInbox(userId: string): Promise<void> {
  for (const event of await untriagedEvents(userId)) {
    await setEventTier(event.id, ruleTier(event) ?? await decideTier(userId, event))
  }
}

/**
 * Triages the inbox and starts a Coordinator turn for this person unless all
 * that waits is background. Call it after the event is committed. Never
 * throws: an event whose wake fails waits for the next one.
 */
export async function wakeCoordinator(userId: string): Promise<void> {
  if (!coordinatorEnabled()) return
  try {
    await triageInbox(userId)
    if (await hasWakingEvents(userId)) await start(coordinatorTurn, [userId])
  } catch (error) {
    console.error('Failed to wake the Coordinator', error instanceof Error ? error.message : error)
  }
}
