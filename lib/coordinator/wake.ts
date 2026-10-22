import 'server-only'
import { experimental_decide as decide, gateway } from 'ai'
import { start } from 'workflow/api'
import { hasWakingEvents, setEventTier, untriagedEvents } from '@/lib/coordinator/store'
import { ruleTier, tierFromDecision, TRIAGE_MODEL, TRIAGE_QUESTIONS, triageState } from '@/lib/coordinator/triage'
import type { CoordinatorEventTier } from '@/lib/db/schema'
import { coordinatorTurn } from '@/workflows/coordinator/workflow'

/** Longest a triage call may take before the event falls back to `result`. */
const TRIAGE_TIMEOUT_MS = 5000

/**
 * Whether the Coordinator runs here: on Vercel (the AI Gateway signs in with
 * the deployment's OIDC token) or wherever a gateway key is set. Elsewhere,
 * events still collect in the inbox and wait.
 */
export function coordinatorEnabled(): boolean {
  return process.env.VERCEL === '1' || Boolean(process.env.AI_GATEWAY_API_KEY)
}

/** Asks the decision model whether a finished run needs the person. A failed call counts as an ordinary result. */
async function decideTier(event: Parameters<typeof triageState>[0]): Promise<CoordinatorEventTier> {
  try {
    const { answers } = await decide({
      model: gateway.decisionModel(TRIAGE_MODEL),
      state: triageState(event),
      questions: TRIAGE_QUESTIONS,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(TRIAGE_TIMEOUT_MS),
    })
    return tierFromDecision(answers.needsPerson.probability)
  } catch (error) {
    console.error('Coordinator triage failed', error instanceof Error ? error.message : error)
    return 'result'
  }
}

/** Gives every untriaged event in the inbox its tier. */
async function triageInbox(userId: string): Promise<void> {
  for (const event of await untriagedEvents(userId)) {
    await setEventTier(event.id, ruleTier(event) ?? await decideTier(event))
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
