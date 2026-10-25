import { COMPOSIO_ACTIONS, actionArguments, type ApprovalActionName, type ComposioActionClient } from '../composio-actions'
import { listComposioPages } from '../composio-pagination'
import { OperationError, type OperationReceipt } from './ledger'
import { calendarEventSummary, type PendingActionView } from '../pending-action-view'
import { createHash } from 'node:crypto'

export interface CalendarProvider {
  name: string
  prepare(ownerId: string, payload?: Record<string, unknown>): Promise<{ accountId: string; version: string; context?: PendingActionView['context'] }>
  execute(input: { ownerId: string; accountId: string; version: string; payload: Record<string, unknown>; idempotencyKey: string; signal: AbortSignal; beforeSend: () => Promise<void> }): Promise<OperationReceipt>
  lookup(input: { ownerId: string; accountId: string; idempotencyKey: string }): Promise<OperationReceipt | null>
}
/** Shared adapter for the three existing approved actions. The retained name
 * keeps Calendar-create callers compatible. No provider idempotency claim:
 * send/create/update do not establish a client key or lookup-by-key here.
 */
export function composioCalendarProvider(client: ComposioActionClient | null, action: ApprovalActionName = 'create_calendar_event'): CalendarProvider {
  const definition = COMPOSIO_ACTIONS[action]
  async function accounts(ownerId: string) {
    if (!client) throw new OperationError('composioNotConfigured')
    return (await listComposioPages(cursor => client.connectedAccounts.list({ userIds: [ownerId], toolkitSlugs: [definition.toolkit], statuses: ['ACTIVE'], cursor })))
      .filter(account => account.toolkit.slug === definition.toolkit && account.status === 'ACTIVE' && !account.isDisabled)
  }
  return {
    name: `composio-${definition.toolkit}`,
    async prepare(ownerId, payload) {
      const active = await accounts(ownerId)
      if (active.length !== 1) throw new OperationError('integrationAccountUnavailable')
      const tool = await client!.tools.getRawComposioToolBySlug(definition.slug)
      if (!tool.version || tool.version === 'latest') throw new OperationError('integrationActionVersionUnavailable')
      let context: PendingActionView['context'] = null
      if (action === 'update_calendar_event') {
        const read = COMPOSIO_ACTIONS.get_calendar_event
        const schema = await client!.tools.getRawComposioToolBySlug(read.slug)
        if (!schema.version || schema.version === 'latest') throw new OperationError('integrationActionVersionUnavailable')
        const result = await client!.tools.execute(read.slug, { userId: ownerId, connectedAccountId: active[0].id, version: schema.version, arguments: actionArguments('get_calendar_event', { event_id: payload?.event_id }) })
        if (!result.successful) throw new OperationError('eventNotReadable')
        context = calendarEventSummary(result.data)
      }
      return { accountId: active[0].id, version: tool.version, context }
    },
    async execute(input) {
      input.signal.throwIfAborted()
      if (!(await accounts(input.ownerId)).some(account => account.id === input.accountId)) throw new OperationError('integrationAccountUnavailable')
      input.signal.throwIfAborted()
      await input.beforeSend()
      input.signal.throwIfAborted()
      const result = await client!.tools.execute(definition.slug, {
        userId: input.ownerId, connectedAccountId: input.accountId, version: input.version,
        arguments: actionArguments(action, input.payload),
      }, {
        signal: input.signal,
        // The SDK fetches its schema asynchronously inside execute(). This hook
        // runs after that preflight and immediately before its non-retrying write.
        beforeExecute: async ({ params }) => {
          input.signal.throwIfAborted()
          await input.beforeSend()
          input.signal.throwIfAborted()
          return params
        },
      })
      if (!result.successful) throw new OperationError('operationUncertain')
      const data = result.data as Record<string, unknown> | undefined
      const nested = data?.response_data as Record<string, unknown> | undefined
      const id = nested?.id ?? data?.id
      if (typeof id !== 'string' || !id || (action === 'update_calendar_event' && id !== input.payload.event_id)) throw new OperationError('operationUncertain')
      return { providerObjectId: id, evidenceDigest: createHash('sha256').update(JSON.stringify([input.accountId, id])).digest('hex') }
    },
    async lookup() { return null },
  }
}
