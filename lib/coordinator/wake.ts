import { defaultModelAvailable } from '@/lib/default-model'
import 'server-only'
import { start } from 'workflow/api'
import { releaseAttention } from '@/lib/attention/store'
import { claimTriageAttempt, completeTriageAttempt, hasWakingEvents, setEventTier, untriagedEvents, wakingChats } from '@/lib/coordinator/store'
import { invokeDecision } from '@/lib/coordinator/decide'
import { tierFromDecision, triageQuestions, triageInput } from '@/lib/coordinator/triage'
import { coordinatorTurn } from '@/workflows/coordinator/workflow'
import { coordinatorWakeDeadline } from '@/workflows/coordinator-wake-recovery/workflow'
import { runTestFixture } from '@/lib/run-test-fixture'
import { runTriageBatch, TRIAGE_BATCH_BUDGET_MS } from './triage-batch'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { createWakeRecovery, deliverWake, type DeadlineWakeClaim, type WakeClaim, type WakeDeadlineTicket, type WakeScope } from './wake-recovery'
import { failureLine } from './refusal-line'
import { pushByDecision } from './push-decision'
import type { InboxEvent } from '@/lib/push-reasons'
import { coordinatorBot } from './coordinator-bot'
import { deliverRunCompletion } from './run-completion-delivery'

const recovery = createWakeRecovery(pool)

/**
 * Whether this chat can use a configured default or its own selected
 * credential. Elsewhere, events still collect in the inbox and wait.
 */
export async function coordinatorEnabled(ownerId?: string, botId: string | null = null): Promise<boolean> {
  if (ownerId && botId) {
    const { botChatOwnerExclusive, sharedBotHasAuthorizedReply } = await import('@/lib/collaboration/bot-chat')
    if (!await botChatOwnerExclusive(pool, ownerId, botId)) return sharedBotHasAuthorizedReply(ownerId, botId)
  }
  if (runTestFixture('mock') !== undefined || await defaultModelAvailable(ownerId)) return true
  return ownerId ? (await import('./model-ready')).botModelReady(ownerId, botId) : false
}

/** No answer leaves the event pending; it does not become background, result or a request for human approval. */
export async function triageInbox(userId: string, botId: string): Promise<void> {
  'use step'
  const { hostedBillingScope } = await import('@/lib/abuse/context')
  const { executionWorkspace } = await import('@/lib/execution-settings')
  const scope = { userId, botId }
  const budget = AbortSignal.timeout(TRIAGE_BATCH_BUDGET_MS)
  const outcome = await runTriageBatch(await untriagedEvents(userId, botId), {
    claim: event => claimTriageAttempt(event, scope),
    deliverUser: event => setEventTier(event.id, 'attention', scope),
    deliverCompletion: event => deliverRunCompletion(pool, event, scope, workspacePool),
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
 * Claimed batches also get a durable deadline. The independent sweep still
 * repairs the commit-to-start gap and workflow infrastructure failures.
 */
export async function wakeCoordinator(userId: string): Promise<void> {
  try {
    // Resolving the Coordinator first moves any of its chat still stored the old way onto its personal Coordinator.
    // A person with no workspace to resolve has no Coordinator turn to start; their bots still wake.
    await coordinatorBot(userId, null).catch(() => undefined)
    await releaseAttention(userId)
    for (const botId of await wakingChats(userId)) {
      if (await coordinatorEnabled(userId, botId)) await wakeChat({ userId, botId })
    }
  } catch (error) {
    // Name and code only: messages can carry chat or database content.
    console.error('Failed to wake the Coordinator', { name: error instanceof Error ? error.name : typeof error, code: (error as { code?: unknown } | null)?.code })
  }
}

async function wakeChat(scope: WakeScope) {
  const claim = await recovery.claim(scope)
  if (!claim) return 'deferred' as const
  const delivered = await deliverClaim(claim)
  if (delivered.ticket) {
    // Both claim and failure tickets are returned only after their real COMMIT.
    // An unknown start outcome is not retried here; the inbox/sweep retains it.
    try { await start(coordinatorWakeDeadline, [delivered.ticket]) }
    catch { console.error('Coordinator wake deadline scheduling failed', { eventIds: claim.ids, attempt: claim.attempt }) }
  }
  return delivered.result
}

async function deliverClaim(claim: DeadlineWakeClaim) {
  let ticket = claim.ticket
  const result = await deliverWake(claim, {
    triage: value => triageInbox(value.userId, value.botId),
    hasWaking: value => hasWakingEvents(value.userId, value.botId),
    start: async value => {
      const run = await start(coordinatorTurn, [value.userId, value.botId, 1])
      console.info('Coordinator wake accepted', { workflowRunId: run.runId, eventIds: claim.ids, attempt: claim.attempt })
    },
    failed: async (value, code) => { ticket = await recovery.failed(value, code) },
    // The last attempt gave up: no turn will run to say so, so the phone gets the line the chat shows (回复重试已停止).
    exhausted: value => noticeWakeExhausted(value).catch(() => console.error('Wake failure notice failed', { eventIds: value.ids })),
  })
  if (result === 'failed') console.error('Coordinator wake delivery failed', { eventIds: claim.ids, attempt: claim.attempt })
  return { result, ticket }
}

/** Internal durable step: preserve the bounded batch instead of waking an unrestricted chat. */
export async function recoverWakeDeadline(ticket: WakeDeadlineTicket): Promise<{ ticket: WakeDeadlineTicket; at: string } | null> {
  if (!await coordinatorEnabled(ticket.userId, ticket.botId)) return null
  const next = await recovery.resume(ticket)
  if (next.kind === 'obsolete') return null
  if (next.kind === 'wait') return { ticket, at: next.at }
  const delivered = await deliverClaim(next.claim)
  return delivered.ticket ? { ticket: delivered.ticket, at: delivered.ticket.at } : null
}

async function noticeWakeExhausted(claim: WakeClaim) {
  const line = failureLine('wake_exhausted')
  if (!line) return
  const events = (await pool.query<InboxEvent>('SELECT kind,tier FROM coordinator_events WHERE "userId"=$1 AND id=ANY($2::uuid[])', [claim.userId, claim.ids])).rows
  if (events.length) await pushByDecision(claim.userId, claim.botId, line, events)
}

/** Called every minute by the existing scheduling Worker. The persisted next
 * attempt/lease timestamps make overlapping sweeps converge. */
export async function retryCoordinatorWakes(deadline = Date.now() + 45_000) {
  const counts = { due: 0, started: 0, deferred: 0, failed: 0, exhausted: 0, interrupted: 0 }
  // First, so a turn whose run ended without releasing its chat is retried in this same sweep.
  try { counts.interrupted = (await (await import('./interrupted-turns')).recoverInterruptedTurns()).recovered } catch { /* the lease expiry still frees it */ }
  const scopes = await recovery.due()
  counts.due = scopes.length
  for (const scope of scopes) {
    if (Date.now() >= deadline) { counts.deferred++; continue }
    // A wake recorded before chats had bots names none: it was the Coordinator's older chat, now the personal one's.
    try {
      const botId = scope.botId ?? (await coordinatorBot(scope.userId, null)).botId
      if (!await coordinatorEnabled(scope.userId, botId)) { counts.deferred++; continue }
      counts[await wakeChat({ userId: scope.userId, botId })]++
    }
    catch { counts.failed++ }
  }
  counts.exhausted = await recovery.exhausted()
  return counts
}

export const replayCoordinatorWake = (eventId: string) => recovery.replay(eventId)
