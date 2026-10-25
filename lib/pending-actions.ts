import 'server-only'
import { and, eq, gt } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { isApprovalAction } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { actionDecidedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { db } from '@/lib/db'
import { pendingActions } from '@/lib/db/schema'
import { actionOutcome, PENDING_ACTION_TTL_MS } from '@/lib/pending-action-view'

/**
 * The person approves or declines one proposal. Approving runs exactly the
 * input they saw; the status moves off `pending` first, so a double click or a
 * second tab cannot run it twice. The Coordinator hears the outcome.
 */
export async function decidePendingAction(userId: string, id: string, approve: boolean) {
  const [row] = await db.update(pendingActions)
    .set({ status: approve ? 'running' : 'declined', decidedAt: new Date() })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
    .returning()
  if (!row || !isApprovalAction(row.action)) throw new ActionFailureError('pendingActionUnavailable')

  let status: 'done' | 'failed' | 'declined' = 'declined'
  let error: string | null = null
  let outcome: Record<string, string> = {}
  if (approve) {
    const result = await runComposioAction(userId, row.action, row.input, `approved-action:${row.id}`)
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
