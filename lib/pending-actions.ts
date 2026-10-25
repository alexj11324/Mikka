import 'server-only'
import { OperationError } from './operations/ledger'
import { calendarOperations } from './operations/calendar-runtime'
import { and, eq, gt } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { isApprovalAction } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { actionDecidedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { db } from '@/lib/db'
import { coordinatorEvents, pendingActions } from '@/lib/db/schema'
import { actionOutcome, PENDING_ACTION_TTL_MS } from '@/lib/pending-action-view'

/**
 * The person approves or declines one proposal. Approving runs exactly the
 * input they saw; the status moves off `pending` first, so a double click or a
 * second tab cannot run it twice. The Coordinator hears the outcome.
 */
export async function decidePendingAction(userId: string, id: string, approve: boolean, sessionId?: string) {
  const [existing] = await db.select().from(pendingActions).where(and(eq(pendingActions.id, id), eq(pendingActions.userId, userId))).limit(1)
  if (existing?.action === 'create_calendar_event') {
    if (!sessionId) throw new ActionFailureError('pendingActionUnavailable')
    try {
      const result = await calendarOperations().decide({ userId, sessionId }, id, approve)
      if (result.status === 'running') {
        await db.insert(coordinatorEvents).values({ id: crypto.randomUUID(), userId, kind: 'action_decided', dedupeKey: `action_uncertain:${id}`, issueId: null, runId: null, tier: 'attention', payload: { actionId: id, action: existing.action, input: existing.input, status: 'uncertain', error: 'Outcome unknown. Check the provider or retry the approval to reconcile; no automatic resend.' } }).onConflictDoNothing({ target: coordinatorEvents.dedupeKey })
        await wakeCoordinator(userId)
      } else {
        const [completed] = await db.select().from(pendingActions).where(eq(pendingActions.id, id)).limit(1)
        await recordCoordinatorEvent(db, actionDecidedEvent(existing, { status: result.status, error: result.error, outcome: (completed?.result ?? {}) as Record<string, string> }))
        await wakeCoordinator(userId)
      }
      return result
    } catch (error) {
      if (error instanceof OperationError) throw new ActionFailureError('pendingActionUnavailable')
      throw error
    }
  }
  const [row] = await db.update(pendingActions)
    .set({ status: approve ? 'running' : 'declined', decidedAt: new Date() })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
    .returning()
  if (!row || !isApprovalAction(row.action)) throw new ActionFailureError('pendingActionUnavailable')

  let status: 'done' | 'failed' | 'declined' = 'declined'
  let error: string | null = null
  let outcome: Record<string, string> = {}
  if (approve) {
    const result = await runComposioAction(userId, row.action, row.input)
    if ('error' in result) {
      status = 'failed'
      error = result.error
    } else {
      status = 'done'
      outcome = actionOutcome(result.data)
    }
    await db.update(pendingActions).set({ status, error, result: outcome }).where(eq(pendingActions.id, row.id))
  }
  await recordCoordinatorEvent(db, actionDecidedEvent({ id: row.id, userId, action: row.action, input: row.input }, { status, error, outcome }))
  await wakeCoordinator(userId)
  return { status, error }
}
