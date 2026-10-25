import { coordinatorInboxOptions } from './inbox-runtime'
import { controlledWakeConfiguration, startControlledWake } from './wake-controlled'
import { CoordinatorInbox, WakeError, type WakeDelivery } from './inbox-receipts'
import { retryInboxWakes } from './inbox-retry'
import { pool } from '@/lib/db'
import 'server-only'
import { start } from 'workflow/api'
import { setEventTier } from '@/lib/coordinator/store'
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
async function decideTier(userId: string, event: Parameters<typeof triageState>[0]): Promise<CoordinatorEventTier> {
  const answer = (await decide('triage', decisionInput(triageState(event)), triageQuestions(event), userId))?.get('needsPerson')
  if (answer?.type === 'predicate') return tierFromDecision(answer.probability, event.kind)
  return event.kind === 'run_report' ? 'background' : 'result'
}

/** Classify due inputs before the dispatcher can reserve/start a workflow.
 * Unknown decision-model work remains untriaged when resource policy defers. */
async function triageInbox(userId?: string, limit = 25): Promise<void> {
  const options = coordinatorInboxOptions(),
    inbox = new CoordinatorInbox(pool, options)
  const rows = (
    await pool.query(
      `SELECT id,"userId" FROM coordinator_events WHERE ($1::text IS NULL OR "userId"=$1) AND tier IS NULL AND "deliveredAt" IS NULL AND processed_at IS NULL AND wake_status IN ('pending','running') AND wake_next_at<=clock_timestamp() ORDER BY sequence LIMIT $2`,
      [userId ?? null, limit],
    )
  ).rows
  let decisions = 0
  for (const row of rows) {
    try {
      const event = await inbox.read(row.userId, row.id)
      let tier = ruleTier(event)
      if (tier == null) {
        if (process.env.DECISION_GATEWAY_API_KEY) {
          if (decisions >= 3) continue
          const admission = await options.admit?.(
            {
              ownerId: event.userId,
              workspaceId: event.wake_workspace_id,
              operationId: event.id,
              generation: event.wake_replays,
            },
            'dispatch',
          )
          if (!admission?.admitted) {
            await inbox.deferTriage(event.userId, event.id, admission?.retryAt ?? new Date(Date.now() + 60000))
            continue
          }
          await inbox.read(row.userId, row.id)
          decisions++
        }
        tier = await decideTier(event.userId,event)
      }
      await setEventTier(event.id, tier)
    } catch (error) {
      if (error instanceof WakeError && error.status === 403) {
        await inbox.denyTriage(row.userId, row.id, error.code)
        continue
      }
      throw error
    }
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
    await retryInboxWakes(pool, deliverCoordinatorWake, true, 1, { ...coordinatorInboxOptions(), onlyOwner: userId })
  } catch {
    console.error('Coordinator wake unavailable; the persisted inbox will retry')
  }
}

/** Shared delivery entry. Compensation must observe failures; request-side
 * wakeCoordinator keeps its historical best-effort response contract. */
async function deliverCoordinatorWake(userId: string, delivery: WakeDelivery) {
  if (controlledWakeConfiguration()) return startControlledWake(userId, delivery)
  const run = await start(coordinatorTurn, [userId, delivery])
  return { runId: run.runId }
}

/** The runtime sweep shares the existing inbox delivery mechanism. */
export async function retryCoordinatorInbox(limit = 25) {
  if (coordinatorEnabled()) await triageInbox(undefined, limit)
  return retryInboxWakes(pool, deliverCoordinatorWake, coordinatorEnabled(), limit, coordinatorInboxOptions())
}
