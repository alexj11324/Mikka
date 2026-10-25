import { coordinatorInboxOptions } from './inbox-runtime'
import { controlledWakeConfiguration, startControlledWake } from './wake-controlled'
import type { WakeDelivery } from './inbox-receipts'
import { retryInboxWakes } from './inbox-retry'
import { pool } from '@/lib/db'
import 'server-only'
import { start } from 'workflow/api'
import { setEventTier, untriagedEvents } from '@/lib/coordinator/store'
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
  return Boolean(controlledWakeConfiguration()) || process.env.VERCEL === '1' || Boolean(process.env.AI_GATEWAY_API_KEY)
}

/** Asks the decision model whether an event needs the person. When it does not answer, the event gets its quiet tier. */
async function decideTier(event: Parameters<typeof triageState>[0]): Promise<CoordinatorEventTier> {
  const answer = (await decide('triage', decisionInput(triageState(event)), triageQuestions(event)))?.get('needsPerson')
  if (answer?.type === 'predicate') return tierFromDecision(answer.probability, event.kind)
  return event.kind === 'run_report' ? 'background' : 'result'
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
    await retryInboxWakes(pool, deliverCoordinatorWake, true, 1, { ...coordinatorInboxOptions(), onlyOwner: userId })
  } catch {
    console.error('Coordinator wake unavailable; the persisted inbox will retry')
  }
}

/** Shared delivery entry. Compensation must observe failures; request-side
 * wakeCoordinator keeps its historical best-effort response contract. */
async function deliverCoordinatorWake(userId: string, delivery: WakeDelivery) {
  await triageInbox(userId)
  if(controlledWakeConfiguration())return startControlledWake(userId,delivery)
  const run=await start(coordinatorTurn,[userId,delivery])
  return{runId:run.runId}
}

/** The runtime sweep shares the existing inbox delivery mechanism. */
export async function retryCoordinatorInbox(limit = 25) {
  return retryInboxWakes(pool, deliverCoordinatorWake, coordinatorEnabled(), limit, coordinatorInboxOptions())
}
