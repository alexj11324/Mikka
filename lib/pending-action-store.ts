import 'server-only'
import { and, desc, eq, gt } from 'drizzle-orm'
import { appToolCallSchema, APP_TOOL_ACTION, type AppToolCall } from '@/lib/app-tools'
import { COMPOSIO_ACTIONS, isApprovalAction, parseActionInput } from '@/lib/composio-actions'
import { serverWriteJudge, type WriteJudge } from '@/lib/operations/write-judgment'
import { resolveActionAccount, runComposioAction } from '@/lib/composio'
import { db } from '@/lib/db'
import { pendingActions } from '@/lib/db/schema'
import { actionOutcome, calendarEventSummary, PENDING_ACTION_TTL_MS, type PendingActionView } from '@/lib/pending-action-view'
import { PULL_REQUEST_APPROVAL, pullRequestApprovalInput } from '@/lib/github/pull-request-approval'

/** Most proposals one person can have waiting at once. */
const MAX_PENDING = 20

/**
 * Sends mail or writes the calendar in the person's connected account, with
 * no card (decision 2026-10-31): the connection's grant is the permission and
 * only a destructive call asks. The Decisions API judges this exact call, with
 * the tool's MCP annotations as input; a destructive, unjudged or refused call
 * goes to `proposeAction` instead. The row is written before dispatch and kept
 * as the record; like other writes the policy allows, it has no `decidedAt`
 * and never shows as a card.
 */
export async function writeAccountAction(userId: string, action: string, input: unknown, selectedAccountId?: string, botId: string | null = null, judge: WriteJudge = serverWriteJudge(userId, botId)) {
  if (!isApprovalAction(action)) return { error: 'integrationActionNotAllowed' }
  const parsed = parseActionInput(action, input)
  if (!parsed) return { error: 'invalidIntegrationInput' }
  const id = crypto.randomUUID()
  let recorded = false as boolean
  const result = await runComposioAction(userId, action, parsed, selectedAccountId, async (accountId, tool) => {
    if (await judge({ action, tool: COMPOSIO_ACTIONS[action].slug, annotations: tool.tags, input: parsed }) === 'ask') return { error: 'integrationApprovalRequired' }
    await db.insert(pendingActions).values({ id, userId, botId, action, input: parsed, connectedAccountId: accountId, status: 'running' })
    recorded = true
    return null
  })
  if ('error' in result && result.error === 'integrationApprovalRequired') return proposeAction(userId, action, parsed, selectedAccountId, botId)
  // The gate runs before every dispatch, so an unrecorded result never sent anything.
  if (!recorded) return 'error' in result ? result : { error: 'integrationActionFailed' }
  if ('error' in result) {
    // operationUncertain stays running: it may have been sent, so never invite a resend.
    await db.update(pendingActions).set({ status: result.error === 'operationUncertain' ? 'running' : 'failed', error: result.error }).where(eq(pendingActions.id, id))
    return result
  }
  const outcome = actionOutcome(result.data)
  await db.update(pendingActions).set({ status: 'done', result: outcome }).where(eq(pendingActions.id, id))
  return { status: 'done' as const, actionId: id, outcome }
}

/**
 * Saves what an agent wants to do in the person's accounts, for the person to
 * approve. Nothing runs here. A calendar change also reads the event as it is
 * now, so the card can show what changes.
 */
export async function proposeAction(userId: string, action: string, input: unknown, selectedAccountId?: string, botId: string | null = null) {
  if (!isApprovalAction(action)) return { error: 'integrationActionNotAllowed' }
  const parsed = parseActionInput(action, input)
  if (!parsed) return { error: 'invalidIntegrationInput' }
  const waiting = await db.$count(pendingActions, and(eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
  if (waiting >= MAX_PENDING) return { error: 'tooManyPendingActions: ask the person to approve or decline the waiting ones first' }
  const { accountId, accounts } = await resolveActionAccount(userId, action, selectedAccountId)
  if (!accountId) return accounts.length ? { error: 'integrationAccountSelectionRequired', accounts } : { error: 'integrationNotConnected' }
  let context: PendingActionView['context'] = null
  if (action === 'update_calendar_event') {
    const current = await runComposioAction(userId, 'get_calendar_event', { event_id: parsed.event_id }, accountId)
    if ('error' in current) return { error: `eventNotReadable: ${current.error}` }
    context = calendarEventSummary(current.data)
  }
  const id = crypto.randomUUID()
  await db.insert(pendingActions).values({ id, userId, botId, action, input: parsed, context, connectedAccountId: accountId })
  return { status: 'awaiting_approval', actionId: id }
}

/**
 * A store app's tool call that needs the person's approval (a destructive
 * write, or one an explicit setting asks for). Nothing runs here.
 */
export async function proposeAppToolCall(userId: string, call: AppToolCall, accountId: string, botId: string | null = null) {
  const parsed = appToolCallSchema.safeParse(call)
  if (!parsed.success) return { error: 'invalidIntegrationInput' }
  const waiting = await db.$count(pendingActions, and(eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
  if (waiting >= MAX_PENDING) return { error: 'tooManyPendingActions: ask the person to approve or decline the waiting ones first' }
  const id = crypto.randomUUID()
  await db.insert(pendingActions).values({ id, userId, botId, action: APP_TOOL_ACTION, input: parsed.data, connectedAccountId: accountId })
  return { status: 'awaiting_approval', actionId: id }
}

/** The person's proposals still waiting for them, newest first. */
export async function listPendingActions(userId: string): Promise<PendingActionView[]> {
  // Rendering existing cards must remain compatible before the account-binding
  // migration runs. Only proposal creation/execution needs the new column.
  const rows = await db.select({
    id: pendingActions.id, action: pendingActions.action, input: pendingActions.input,
    context: pendingActions.context, status: pendingActions.status, createdAt: pendingActions.createdAt,
  }).from(pendingActions)
    .where(and(eq(pendingActions.userId, userId), eq(pendingActions.status, 'pending'), gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS))))
    .orderBy(desc(pendingActions.createdAt)).limit(MAX_PENDING)
  return rows.flatMap<PendingActionView>(row => {
    if (row.action === 'credential_operation' || row.action === 'browser_operation') {
      if (Date.now() - row.createdAt.getTime() > 5 * 60_000) return []
      return [{ id: row.id, action: row.action, input: { summary: row.input.summary, origin: row.input.origin, operation: row.input.operation, description: row.action === 'credential_operation' ? 'The page stays hidden until entered login fields are absent. This does not confirm authentication.' : undefined }, context: null, status: row.status, createdAt: row.createdAt.toISOString() }]
    }
    if (row.action === APP_TOOL_ACTION) return appToolCallSchema.safeParse(row.input).success ? [{ id: row.id, action: APP_TOOL_ACTION, input: row.input, context: null, status: row.status, createdAt: row.createdAt.toISOString() }] : []
    if (row.action === PULL_REQUEST_APPROVAL) return pullRequestApprovalInput.safeParse(row.input).success ? [{ id: row.id, action: PULL_REQUEST_APPROVAL, input: row.input, context: null, status: row.status, createdAt: row.createdAt.toISOString() }] : []
    // A repository push card from before decision 2026-11-01-1215 is no longer shown: the GitHub App grant decides the push.
    if (!isApprovalAction(row.action)) return []
    return [{ id: row.id, action: row.action as PendingActionView['action'], input: row.input, context: row.context as PendingActionView['context'], status: row.status, createdAt: row.createdAt.toISOString() }]
  })
}
