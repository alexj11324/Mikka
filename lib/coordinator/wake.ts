import 'server-only'
import { start } from 'workflow/api'
import { releaseAttention } from '@/lib/attention/store'
import { claimTriageAttempt, completeTriageAttempt, hasWakingEvents, setEventTier, untriagedEvents, wakingChats } from '@/lib/coordinator/store'
import { invokeDecision } from '@/lib/coordinator/decide'
import { tierFromDecision, triageQuestions, triageInput } from '@/lib/coordinator/triage'
import { coordinatorTurn } from '@/workflows/coordinator/workflow'
import { runTriageBatch, TRIAGE_BATCH_BUDGET_MS } from './triage-batch'

/**
 * Whether the Coordinator runs here: on Vercel (the AI Gateway signs in with
 * the deployment's OIDC token) or wherever a gateway key is set. Elsewhere,
 * events still collect in the inbox and wait. `MIKKA_NATIVE_COORDINATOR`
 * (deprecated #312 runtime, keep unset) also enables it.
 */
export function coordinatorEnabled(): boolean {
  return process.env.MIKKA_NATIVE_COORDINATOR === '1' || process.env.VERCEL === '1' || Boolean(process.env.AI_GATEWAY_API_KEY)
}

/** No answer leaves the event pending; it does not become background, result or a request for human approval. */
export async function triageInbox(userId: string, botId: string | null = null): Promise<void> {
  const scope = { userId, botId }
  const budget = AbortSignal.timeout(TRIAGE_BATCH_BUDGET_MS)
  const outcome = await runTriageBatch(await untriagedEvents(userId, botId), {
    claim: event => claimTriageAttempt(event, scope),
    deliverUser: event => setEventTier(event.id, 'attention', scope),
    classify: async (event, signal) => {
      const result = await invokeDecision('triage', triageInput(event), triageQuestions(event), signal)
      return { tier: tierFromDecision(result?.answers.get('tier')), execution: result?.execution ?? null }
    },
    complete: (event, attemptedAt, judgment) => completeTriageAttempt(event, scope, attemptedAt, judgment),
    observe: (event, judgment, application) => console.info('Coordinator model judgment observed', { eventId: event.id, ...judgment.execution, application }),
  }, budget)
  for (const eventId of outcome.pending) console.error('Coordinator event judgment pending', { eventId })
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
