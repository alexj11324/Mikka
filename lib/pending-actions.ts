import 'server-only'
import { OperationError } from './operations/ledger'
import { approvedActionOperations } from './operations/calendar-runtime'
import { and, eq } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { isApprovalAction } from '@/lib/composio-actions'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { actionDecidedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { db } from '@/lib/db'
import { coordinatorEvents, pendingActions } from '@/lib/db/schema'

/** The person decides an existing proposal. All approved external actions use
 * the durable invocation fence; unknown results stay visible without resend. */
export async function decidePendingAction(userId: string, id: string, approve: boolean, sessionId?: string) {
  const [existing] = await db.select().from(pendingActions).where(and(eq(pendingActions.id, id), eq(pendingActions.userId, userId))).limit(1)
  if (existing && isApprovalAction(existing.action)) {
    if (!sessionId) throw new ActionFailureError('pendingActionUnavailable')
    try {
      const result = await approvedActionOperations(existing.action).decide({ userId, sessionId }, id, approve)
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
  throw new ActionFailureError('pendingActionUnavailable')
}
