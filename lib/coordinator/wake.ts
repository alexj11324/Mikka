import { defaultModelAvailable } from '@/lib/default-model'
import 'server-only'
import { releaseAttention } from '@/lib/attention/store'
import { claimTriageAttempt, completeTriageAttempt, setEventTier, untriagedEvents, wakingChats } from '@/lib/coordinator/store'
import { invokeDecision } from '@/lib/coordinator/decide'
import { tierFromDecision, triageQuestions, triageInput } from '@/lib/coordinator/triage'
import { runTestFixture } from '@/lib/run-test-fixture'
import { runTriageBatch, TRIAGE_BATCH_BUDGET_MS } from './triage-batch'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { coordinatorBot } from './coordinator-bot'
import { deliverRunCompletion } from './run-completion-delivery'
import { verifiedCiSuiteTransport } from './ci-suite-transport'


/**
 * Whether this chat can use a configured default or its own selected
 * credential. Elsewhere, events still collect in the inbox and wait.
 */
export async function coordinatorEnabled(ownerId?: string, botId: string | null = null): Promise<boolean> {
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
    // Signed-webhook, source-bound CI result is transport, not another model
    // decision. The Bot sees it as a new turn after the outbox commits.
    deliverCiSuite: event => verifiedCiSuiteTransport(event)
      ? setEventTier(event.id, 'result', scope) : Promise.resolve(false),
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

/** Product outbox delivery only. eve owns turn queueing, retry and recovery. */
async function wakeChat(scope: { userId: string; botId: string }) {
  await triageInbox(scope.userId,scope.botId)
  const [{rows: events},{rows: bots}] = await Promise.all([
    pool.query<{id:string}>(`SELECT id FROM coordinator_events WHERE "userId"=$1 AND "botId"=$2 AND "deliveredAt" IS NULL AND (kind='user_message' OR (tier IS NOT NULL AND tier<>'background')) ORDER BY "createdAt",id LIMIT 50`,[scope.userId,scope.botId]),
    pool.query<{workspaceId:string}>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2',[scope.botId,scope.userId]),
  ])
  if (!bots[0]) return 'deferred' as const
  const {sendEveEvent} = await import('../eve/server-client')
  for (const event of events) await sendEveEvent({ownerId:scope.userId,botId:scope.botId,workspaceId:bots[0].workspaceId,surface:'web'},event.id)
  return events.length ? 'started' as const : 'deferred' as const
}

/** Compatibility entry for previously queued wake deadlines; no turn lease survives. */
export async function recoverWakeDeadline(ticket: import('./wake-recovery').WakeDeadlineTicket): Promise<null> {
  await wakeCoordinator(ticket.userId)
  return null
}

/** Existing source-outbox reconciliation; never inspects or restarts an eve workflow. */
export async function retryCoordinatorWakes(deadline = Date.now()+45_000) {
  const counts = {due:0,started:0,deferred:0,failed:0,exhausted:0,interrupted:0}
  const scopes = (await pool.query<{userId:string;botId:string}>(`SELECT DISTINCT "userId","botId" FROM coordinator_events WHERE "deliveredAt" IS NULL AND "botId" IS NOT NULL AND (kind='user_message' OR tier IS NULL OR tier<>'background')`)).rows
  counts.due = scopes.length
  for (const scope of scopes) {
    if (Date.now()>=deadline || !await coordinatorEnabled(scope.userId,scope.botId)) {counts.deferred++;continue}
    try { counts[await wakeChat(scope)]++ } catch {counts.failed++}
  }
  return counts
}

export async function replayCoordinatorWake(eventId:string) {
  const row = (await pool.query<{userId:string}>('SELECT "userId" FROM coordinator_events WHERE id=$1 AND "deliveredAt" IS NULL',[eventId])).rows[0]
  if (!row) return false
  await wakeCoordinator(row.userId)
  return true
}
