import 'server-only'
import { OperationError } from './operations/ledger'
import { approvedActionOperations, currentCalendarIntentKey } from './operations/calendar-runtime'
import { and, desc, eq, gt, or } from 'drizzle-orm'
import { isApprovalAction, parseActionInput } from '@/lib/composio-actions'
import { db } from '@/lib/db'
import { pendingActions } from '@/lib/db/schema'
import { PENDING_ACTION_TTL_MS, type PendingActionView } from '@/lib/pending-action-view'

/** Most proposals one person can have waiting at once. */
const MAX_PENDING = 20

/**
 * Saves what an agent wants to do in the person's accounts, for the person to
 * approve. Nothing runs here. A calendar change also reads the event as it is
 * now, so the card can show what changes.
 */
export async function proposeAction(userId: string, action: string, input: unknown) {
  if (!isApprovalAction(action)) return { error: 'integrationActionNotAllowed' }
  const parsed = parseActionInput(action, input)
  if (!parsed) return { error: 'invalidIntegrationInput' }
  try { return await approvedActionOperations(action).propose(userId, parsed, currentCalendarIntentKey()) }
  catch (error) { if (error instanceof OperationError) return { error: error.message }; throw error }
}

/** The person's proposals still waiting for them, newest first. */
export async function listPendingActions(userId: string): Promise<PendingActionView[]> {
  const rows = await db.select().from(pendingActions)
    .where(and(eq(pendingActions.userId, userId), or(and(eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))), eq(pendingActions.status, 'running'))))
    .orderBy(desc(pendingActions.createdAt)).limit(MAX_PENDING)
  return rows.flatMap(row => isApprovalAction(row.action)
    ? [{ id: row.id, action: row.action, input: row.input, context: row.context as PendingActionView['context'], status: row.status, createdAt: row.createdAt.toISOString() }]
    : [])
}
