import 'server-only'
import { and, eq, gt } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { isApprovalAction } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { actionDecidedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { db, pool } from '@/lib/db'
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
  if (!row || (!isApprovalAction(row.action) && row.action !== 'browser_operation' && row.action !== 'credential_operation')) throw new ActionFailureError('pendingActionUnavailable')

  if ((row.action === 'browser_operation' || row.action === 'credential_operation') && Date.now() - row.createdAt.getTime() > 5 * 60_000) {
    await db.update(pendingActions).set({ status: 'failed', error: 'browserActionExpired' }).where(eq(pendingActions.id, row.id))
    throw new ActionFailureError('pendingActionUnavailable')
  }
  let status: 'done' | 'failed' | 'declined' = 'declined'
  let error: string | null = null
  let outcome: Record<string, string> = {}
  if (approve || (row.action === 'browser_operation' || row.action === 'credential_operation')) {
    const result = (row.action === 'browser_operation' || row.action === 'credential_operation')
      ? row.action === 'credential_operation'
        ? await (await import('@/lib/cloud-computer/credential-reviews')).executeCredentialOperation(pool, userId, row.input, approve)
        : await (await import('@/lib/cloud-computer/action-reviews')).executeApprovedBrowserAction(pool, userId, row.input, approve)
      : await runComposioAction(userId, row.action, row.input)
    if ('error' in result) {
      status = 'failed'
      error = result.error
    } else {
      status = approve ? 'done' : 'declined'
      outcome = actionOutcome(result.data)
    }
    await db.update(pendingActions).set({ status, error, result: outcome }).where(eq(pendingActions.id, row.id))
  }
  await recordCoordinatorEvent(db, actionDecidedEvent({ id: row.id, userId, action: row.action, input: row.action === 'credential_operation' ? { summary: (row.input as Record<string, unknown>).summary } : row.input }, { status, error, outcome }))
  await wakeCoordinator(userId)
  return { status, error }
}
