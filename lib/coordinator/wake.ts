import 'server-only'
import { start } from 'workflow/api'
import { releaseAttention } from '@/lib/attention/store'
import { claimTriageAttempt, completeTriageAttempt, hasWakingEvents, setEventTier, untriagedEvents, wakingChats } from '@/lib/coordinator/store'
import { invokeDecision } from '@/lib/coordinator/decide'
import { tierFromDecision, triageQuestions, triageInput } from '@/lib/coordinator/triage'
import { coordinatorTurn } from '@/workflows/coordinator/workflow'
import { runTestFixture } from '@/lib/run-test-fixture'
import { runTriageBatch, TRIAGE_BATCH_BUDGET_MS } from './triage-batch'
import { pool } from '@/lib/db'
import { createWakeRecovery, deliverWake, type WakeScope } from './wake-recovery'

const recovery = createWakeRecovery(pool)

/**
 * Whether the Coordinator runs here: on Vercel (the AI Gateway signs in with
 * the deployment's OIDC token) or wherever a gateway key is set. Elsewhere,
 * events still collect in the inbox and wait. `MIKKA_NATIVE_COORDINATOR`
 * (deprecated #312 runtime, keep unset) also enables it.
 */
export function coordinatorEnabled(): boolean {
  return process.env.MIKKA_NATIVE_COORDINATOR === '1' || process.env.VERCEL === '1' || Boolean(process.env.AI_GATEWAY_API_KEY) || runTestFixture('mock') !== undefined
}

/** No answer leaves the event pending; it does not become background, result or a request for human approval. */
export async function triageInbox(userId: string, botId: string | null = null): Promise<void> {
  'use step'
  const { hostedBillingScope } = await import('@/lib/abuse/context')
  const { executionWorkspace } = await import('@/lib/execution-settings')
  const scope = { userId, botId }
  const budget = AbortSignal.timeout(TRIAGE_BATCH_BUDGET_MS)
  const outcome = await runTriageBatch(await untriagedEvents(userId, botId), {
    claim: event => claimTriageAttempt(event, scope),
    deliverUser: event => setEventTier(event.id, 'attention', scope),
    classify: async (event, signal) => {
      const result = await hostedBillingScope.run({workspaceId:await executionWorkspace(userId,botId),ownerId:userId},()=>invokeDecision('triage', triageInput(event), triageQuestions(event), signal))
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
 * The inbox is also the durable wake outbox. An independent sweep retries a
 * failed start without requiring another user message or external event.
 */
export async function wakeCoordinator(userId: string): Promise<void> {
  if (!coordinatorEnabled()) return
  try {
    await releaseAttention(userId)
    for (const botId of await wakingChats(userId)) {
      await wakeChat({ userId, botId })
    }
  } catch {
    console.error('Failed to wake the Coordinator')
  }
}

async function wakeChat(scope: WakeScope) {
  const claim = await recovery.claim(scope)
  if (!claim) return 'deferred' as const
  const result = await deliverWake(claim, {
    triage: value => triageInbox(value.userId, value.botId),
    hasWaking: value => hasWakingEvents(value.userId, value.botId),
    start: async value => { await start(coordinatorTurn, [value.userId, value.botId]) },
    failed: recovery.failed,
  })
  if (result === 'failed') console.error('Coordinator wake delivery failed', { eventIds: claim.ids, attempt: claim.attempt })
  return result
}

/** Called every minute by the existing scheduling Worker. The persisted next
 * attempt/lease timestamps make overlapping sweeps converge. */
export async function retryCoordinatorWakes(deadline = Date.now() + 45_000) {
  const counts = { due: 0, started: 0, deferred: 0, failed: 0, exhausted: 0 }
  if (!coordinatorEnabled()) return counts
  const scopes = await recovery.due()
  counts.due = scopes.length
  for (const scope of scopes) {
    if (Date.now() >= deadline) { counts.deferred++; continue }
    counts[await wakeChat(scope)]++
  }
  counts.exhausted = await recovery.exhausted()
  return counts
}

export const replayCoordinatorWake = (eventId: string) => recovery.replay(eventId)
