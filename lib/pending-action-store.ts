import 'server-only'
import { and, desc, eq, gt } from 'drizzle-orm'
import { isApprovalAction, parseActionInput } from '@/lib/composio-actions'
import { resolveActionAccount, runComposioAction } from '@/lib/composio'
import { db } from '@/lib/db'
import { pendingActions } from '@/lib/db/schema'
import { calendarEventSummary, PENDING_ACTION_TTL_MS, type PendingActionView } from '@/lib/pending-action-view'

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
  const waiting = await db.$count(pendingActions, and(eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
  if (waiting >= MAX_PENDING) return { error: 'tooManyPendingActions: ask the person to approve or decline the waiting ones first' }
  const accountId = await resolveActionAccount(userId, action)
  if (!accountId) return { error: 'integrationNotConnected' }
  let context: PendingActionView['context'] = null
  if (action === 'update_calendar_event') {
    const current = await runComposioAction(userId, 'get_calendar_event', { event_id: parsed.event_id }, accountId)
    if ('error' in current) return { error: `eventNotReadable: ${current.error}` }
    context = calendarEventSummary(current.data)
  }
  const id = crypto.randomUUID()
  await db.insert(pendingActions).values({ id, userId, action, input: parsed, context, connectedAccountId: accountId })
  return { status: 'awaiting_approval', actionId: id }
}

/** The person's proposals still waiting for them, newest first. */
export async function listPendingActions(userId: string): Promise<PendingActionView[]> {
  const rows = await db.select().from(pendingActions)
    .where(and(eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
    .orderBy(desc(pendingActions.createdAt)).limit(MAX_PENDING)
  return rows.flatMap(row => isApprovalAction(row.action)
    ? [{ id: row.id, action: row.action, input: row.input, context: row.context as PendingActionView['context'], status: row.status, createdAt: row.createdAt.toISOString() }]
    : [])
}
